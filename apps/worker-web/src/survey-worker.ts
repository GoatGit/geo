import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { brands, loadPlatformSettings, personas, personaPools, surveyResponses, surveys, type Db } from '@geo/db';
import { InsightAgent, resolveInsightSettings, validatePersonaAnswerOutput } from '@geo/insight-agent';
import { populationBenchmarkContext, validateSurveyQuestions, validateSurveySegments } from '@geo/shared';

/** PostgreSQL task claim and token fencing keep retries/cancellation safe across worker restarts. */
export class SurveyWorker {
  private stopped = false;
  private task?: Promise<void>;
  constructor(private readonly db: Db, private readonly makeAgent?: () => Promise<InsightAgent>, private readonly concurrency = 3, private readonly synthesisConcurrency = 4) {}

  start() {
    this.task ??= this.loop();
    return this;
  }
  async stop() { this.stopped = true; await this.task; }
  private async loop() {
    while (!this.stopped) {
      try {
        if (await this.processSynthesis()) continue;
        if (await this.processNext()) continue;
      } catch { console.error('[surveys] task polling failed; retrying'); }
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
  }

  /**
   * 超级问卷(0019):人群池档案合成——LLM + 人群职业性格库 RAG 检索。
   * 消化全部 pending 池:认领置 building;段级检索库内中文参考人物,逐 persona LLM 合成生活化档案;
   * 单条失败回落确定性骨架,池永不卡死;building 超 10 分钟无进展视为死任务可重新认领。
   */
  async processSynthesis(): Promise<boolean> {
    let any = false;
    for (;;) {
      const claimed = await this.db.execute(sql`
        with picked as (
          select id from persona_pools
          where synthesis_status = 'pending'
             or (synthesis_status = 'building' and updated_at < now() - interval '10 minutes')
          order by id limit 1 for update skip locked
        )
        update persona_pools p set synthesis_status = 'building', updated_at = now()
        from picked where p.id = picked.id returning p.id`);
      const poolId = Number(claimed.rows[0]?.id);
      if (!poolId) break;
      any = true;
      await this.synthesizePool(poolId);
      if (this.stopped) break;
    }
    return any;
  }

  private async synthesizePool(poolId: number): Promise<boolean> {
    const pool = (await this.db.select().from(personaPools).where(eq(personaPools.id, poolId)))[0];
    if (!pool) return true;
    const settings = resolveInsightSettings((await loadPlatformSettings(this.db)).insightAgent, process.env);
    const agent = this.makeAgent ? await this.makeAgent() : new InsightAgent({ settings });
    const canSynthesize = agent.usable && typeof agent.personaSynthesize === 'function';
    const people = await this.db.select().from(personas).where(eq(personas.poolId, poolId)).orderBy(asc(personas.id));
    // 段级 RAG 检索:同段人物共享库内中文参考(职业/性格),按池种子随机取样
    const referencesBySegment = new Map<number, Array<{ occupation: string; traits: string[] }>>();
    const refsFor = async (segmentIndex: number) => {
      const cached = referencesBySegment.get(segmentIndex);
      if (cached) return cached;
      const seg = pool.spec.segments[segmentIndex];
      let refs: Array<{ occupation: string; traits: string[] }> = [];
      if (seg && canSynthesize) {
        const rows = await this.db.execute(sql`
          select profile from persona_library
          where status = 'ready'
            and profile->>'occupationGroup' = ${seg.occupationGroup}
            and (${seg.gender} = '不限' or profile->>'gender' is null or profile->>'gender' = ${seg.gender})
          order by md5(source_key || ${String(poolId)}) limit 3`);
        refs = (rows.rows as Array<{ profile: Record<string, unknown> }>).map(r => ({
          occupation: String(r.profile?.occupation ?? seg.occupationGroup),
          traits: Array.isArray(r.profile?.traits) ? (r.profile?.traits as string[]).slice(0, 3) : [],
        }));
      }
      referencesBySegment.set(segmentIndex, refs);
      return refs;
    };

    let next = 0;
    let liveness: Promise<unknown> = Promise.resolve();
    await Promise.all(Array.from({ length: Math.min(this.synthesisConcurrency, people.length) }, async () => {
      while (!this.stopped) {
        const person = people[next++];
        if (!person) return;
        if (person.profile?.synthesized) continue;
        const segmentIndex = Number(String(person.profile?.sampleKey ?? '1-1').split('-')[0]) - 1;
        const seg = pool.spec.segments[segmentIndex] ?? pool.spec.segments[0];
        const quota = {
          ageBand: seg?.ageBand ?? '', cityTier: seg?.cityTier ?? '', incomeBand: seg?.incomeBand ?? '',
          gender: (person.profile?.gender as string) ?? seg?.gender ?? '', occupationGroup: seg?.occupationGroup ?? '',
        };
        const refs = canSynthesize && seg ? await refsFor(segmentIndex) : [];
        const synthesized = canSynthesize && seg
          ? await agent.personaSynthesize!({ quota, references: refs, populationContext: populationBenchmarkContext() }).then(r => r?.profile ?? null).catch(() => null)
          : null;
        const merged = synthesized
          ? { ...person.profile, ...synthesized, ...quota, synthesized: true }
          : { ...person.profile, synthesized: true }; // LLM 不可用/失败:保留确定性骨架,不阻塞池
        await this.db.update(personas).set({ profile: merged as Record<string, unknown> }).where(eq(personas.id, person.id));
        liveness = liveness.then(() => this.db.update(personaPools).set({ updatedAt: new Date() }).where(eq(personaPools.id, poolId))).catch(() => undefined);
      }
    }));
    await liveness;
    await this.db.update(personaPools).set({ synthesisStatus: 'ready', updatedAt: new Date() }).where(eq(personaPools.id, poolId));
    return true;
  }

  async processNext(): Promise<boolean> {
    const token = randomUUID();
    const claimed = await this.db.execute(sql`
      with picked as (
        select id from surveys
        where status in ('generating', 'queued', 'running')
          and (heartbeat_at is null or heartbeat_at < now() - interval '3 minutes')
        order by updated_at, id limit 1 for update skip locked
      )
      update surveys s set task_token = ${token}, heartbeat_at = now(), updated_at = now(),
        status = case when s.status = 'generating' then 'generating' else 'running' end
      from picked where s.id = picked.id returning s.id`);
    // 生成任务硬超时:心跳可能仍在(LLM 卡死但进程活着),generating 超 10 分钟
    // 未出结果视为僵死,回 draft 允许用户重试(docs/14:LLM 偶发无响应实测)
    await this.db.execute(sql`
      update surveys set status = 'draft', task_token = null, heartbeat_at = null,
        last_error = 'AI 生成超时（10 分钟无结果），已退回草稿，可重试', updated_at = now()
      where status = 'generating' and updated_at < now() - interval '10 minutes'`);
    const id = Number(claimed.rows[0]?.id);
    if (!id) return false;
    const match = () => and(eq(surveys.id, id), eq(surveys.taskToken, token));
    const alive = async () => (await this.db.select({ token: surveys.taskToken }).from(surveys).where(match())).length > 0;
    const heartbeat = setInterval(() => {
      void this.db.update(surveys).set({ heartbeatAt: new Date() }).where(match()).catch(() => undefined);
    }, 15_000);
    heartbeat.unref();
    let generating = false;
    try {
      const survey = (await this.db.select().from(surveys).where(match()))[0];
      if (!survey) return true;
      generating = survey.status === 'generating';
      // 与 API 侧一致:存储值 ∪ env 引导(避免本地 http 桩/未配 https 的 endpoint 被 SSRF 净化静默清空)
      const settings = resolveInsightSettings((await loadPlatformSettings(this.db)).insightAgent, process.env);
      const agent = this.makeAgent ? await this.makeAgent() : new InsightAgent({ settings });
      if (!agent.usable) throw Error('AI 服务未配置或已停用，请联系管理员配置后重试');
      if (generating) {
        const brand = survey.brandId ? (await this.db.select({ name: brands.name }).from(brands).where(eq(brands.id, survey.brandId)))[0] : null;
        const generated = await agent.generateSurvey({ objective: survey.objective, brandName: brand?.name });
        if (!generated) throw Error('AI 未返回有效问卷，请稍后重新生成，也可手动编辑问卷');
        const questions = validateSurveyQuestions(generated.questions), segments = validateSurveySegments(generated.segments);
        if (!questions.ok || !segments.ok) throw Error('生成的题目或人群不符合要求，请重新生成');
        await this.db.transaction(async tx => {
          const current = (await tx.select({ id: surveys.id }).from(surveys).where(match()).for('update'))[0];
          if (!current) return;
          await tx.update(personaPools).set({ approved: false }).where(eq(personaPools.surveyId, id));
          await tx.update(surveys).set({ questions: questions.value, suggestedSegments: segments.value, activePoolId: null, generationVersion: generated.parserVersion,
            status: 'ready_selecting', lastError: null, heartbeatAt: null, taskToken: null, updatedAt: new Date() }).where(match());
        });
        return true;
      }
      if (!survey.activePoolId || !validateSurveyQuestions(survey.questions).ok) throw Error('问卷或人群数据不完整，请重新检查');
      const pool = (await this.db.select().from(personaPools).where(and(eq(personaPools.id, survey.activePoolId), eq(personaPools.surveyId, id))))[0];
      if (!pool?.approved) throw Error('当前人群未经确认，已停止作答');
      if (pool.synthesisStatus !== 'ready') throw Error('人物档案正在合成中，已完成即可作答');
      const people = await this.db.select().from(personas).where(eq(personas.poolId, pool.id)).orderBy(asc(personas.id));
      if (people.length !== pool.size || !people.length) throw Error('人群数量不一致，请重新生成人群');
      const existing = new Set((await this.db.select({ personaId: surveyResponses.personaId }).from(surveyResponses).where(eq(surveyResponses.surveyId, id))).map(r => r.personaId));
      const remaining = people.filter(p => !existing.has(p.id));
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(this.concurrency, remaining.length) }, async () => {
        while (!this.stopped) {
          const person = remaining[next++];
          if (!person || !await alive()) return;
          const response = await agent.personaAnswer({ profile: person.profile, questions: survey.questions }).catch(() => null);
          const checked = response && validatePersonaAnswerOutput(response, { questions: survey.questions });
          await this.db.transaction(async tx => {
            // The survey row lock serializes with cancel/retry; old work cannot insert into a newer run.
            if (!(await tx.select({ id: surveys.id }).from(surveys).where(match()).for('update'))[0]) return;
            await tx.insert(surveyResponses).values({ surveyId: id, personaId: person.id,
              answers: checked?.ok ? checked.value.answers : [], status: checked?.ok ? 'completed' : 'failed',
              model: settings.model, parserVersion: response?.parserVersion ?? 'survey-answer-invalid-v1',
            }).onConflictDoNothing();
          });
        }
      }));
      if (this.stopped) {
        // Persisted answers survive a shutdown; the next worker can immediately resume.
        await this.db.update(surveys).set({ status: 'queued', taskToken: null, heartbeatAt: null }).where(match());
        return true;
      }
      const counts = (await this.db.select({ ok: sql<number>`count(*) filter (where ${surveyResponses.status} = 'completed')::int`, fail: sql<number>`count(*) filter (where ${surveyResponses.status} = 'failed')::int` }).from(surveyResponses)
        .innerJoin(personas, eq(personas.id, surveyResponses.personaId))
        .where(and(eq(surveyResponses.surveyId, id), eq(personas.poolId, pool.id))))[0]!;
      await this.db.update(surveys).set({ status: counts.ok === pool.size ? 'completed' : counts.ok > 0 ? 'partial' : 'failed',
        lastError: counts.fail ? `${counts.fail} 份作答未通过验证，可补跑缺失样本` : null,
        taskToken: null, heartbeatAt: null, updatedAt: new Date(),
      }).where(match());
    } catch (error) {
      const known = error instanceof Error && /^(AI |生成的|问卷或|当前人群|人群数量)/.test(error.message);
      await this.db.update(surveys).set({ status: generating ? 'draft' : 'failed', taskToken: null, heartbeatAt: null,
        lastError: known ? (error as Error).message : '处理暂时失败，已保留结果，请重试', updatedAt: new Date(),
      }).where(match());
      console.warn(`[surveys] survey=${id} task failed`);
    } finally { clearInterval(heartbeat); }
    return true;
  }
}
