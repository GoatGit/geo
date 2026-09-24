import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { and, eq, sql } from 'drizzle-orm';
import { loadPlatformSettings, personaImportJobs, personaLibrary, type Db } from '@geo/db';
import { InsightAgent, resolveInsightSettings } from '@geo/insight-agent';
import { personaHubUseAllowed } from '@geo/shared';

/** Pinned, allowlisted upstream only. Incremental stream parsing caps memory and resumes idempotently. */
export class PersonaLibraryWorker {
  private stopped = false;
  private task?: Promise<void>;
  constructor(private readonly db: Db, private readonly fetchImpl: typeof fetch = fetch, private readonly makeAgent?: () => Promise<InsightAgent>) {}
  start() { this.task ??= this.loop(); return this; }
  async stop() { this.stopped = true; await this.task; }
  private async loop() {
    while (!this.stopped) {
      try { if (await this.processImport()) continue; if (await this.processEnrichment()) continue; }
      catch { console.warn('[persona-library] task failed; retrying'); }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  async processImport() {
    const token = randomUUID();
    const claim = await this.db.execute(sql`with picked as (select id from persona_import_jobs where status in ('queued','running') and (heartbeat_at is null or heartbeat_at < now()-interval '3 minutes') order by id limit 1 for update skip locked)
      update persona_import_jobs j set status='running',task_token=${token},heartbeat_at=now() from picked where j.id=picked.id returning j.id`);
    const id = Number(claim.rows[0]?.id); if (!id) return false;
    const match = and(eq(personaImportJobs.id, id), eq(personaImportJobs.taskToken, token));
    const beat = setInterval(() => { void this.db.update(personaImportJobs).set({ heartbeatAt: new Date() }).where(match).catch(() => undefined); }, 15000); beat.unref();
    try {
      const job = (await this.db.select().from(personaImportJobs).where(match))[0]!;
      if (!personaHubUseAllowed(process.env)) throw Error('导入需要有效商业授权记录');
      if (!/^https:\/\/raw\.githubusercontent\.com\/tencent-ailab\/persona-hub\/[a-f0-9]{40}\/data\/persona\.jsonl$/.test(job.sourceUrl)) throw Error('上游地址不在允许范围');
      let response: Response;
      const localFile = process.env.PERSONA_HUB_DATA_FILE;
      if (localFile && job.sourceRevision === '72bf19b886312041b32f7cae12c02dab8653c6fa') {
        const info = await stat(localFile);
        if (info.size > 100_000_000) throw Error('上游文件超过 100 MB 限制');
        // Verify the official Git blob, not just a filename. Local mirrors remain attributable.
        const hash = createHash('sha1').update(`blob ${info.size}\0`);
        for await (const chunk of createReadStream(localFile)) hash.update(chunk);
        if (hash.digest('hex') !== '43ec406a7df5c881bfc1723334cf566a4ded2aaa') throw Error('上游文件校验失败：本地镜像与固定版本不一致');
        response = new Response(Readable.toWeb(createReadStream(localFile)) as ReadableStream<Uint8Array>);
      } else response = await this.fetchImpl(job.sourceUrl, { redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!response.ok || !response.body) throw Error('上游数据暂时不可用，请重试导入');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '', processed = 0, imported = 0, bytes = 0;
      const batch: Array<typeof personaLibrary.$inferInsert> = [];
      const flush = async () => {
        if (!batch.length) return;
        await this.db.transaction(async tx => {
          if (!(await tx.select({ id: personaImportJobs.id }).from(personaImportJobs).where(match).for('update'))[0]) throw Error('导入已由其他任务接管');
          const added = await tx.insert(personaLibrary).values(batch).onConflictDoNothing().returning({ id: personaLibrary.id });
          imported += added.length;
          await tx.update(personaImportJobs).set({ processed, imported, updatedAt: new Date() }).where(match);
        }); batch.length = 0;
      };
      const consume = (line: string) => {
        if (!line.trim() || processed >= job.requestedCount) return;
        const raw: unknown = JSON.parse(line);
        const description = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && 'persona' in raw ? (raw as { persona: unknown }).persona : null;
        if (typeof description !== 'string' || !description.trim() || description.length > 10000) throw Error('上游人物数据格式不正确');
        processed++;
        batch.push({ sourceKey: createHash('sha256').update(description.trim()).digest('hex'), description: description.trim(), sourceUrl: job.sourceUrl, sourceRevision: job.sourceRevision, license: job.license, status: 'imported' });
      };
      try {
        while (!this.stopped && processed < job.requestedCount) {
          const { value, done } = await reader.read(); if (done) { buffer += decoder.decode(); if (buffer.trim()) consume(buffer); break; }
          bytes += value.byteLength; if (bytes > 100_000_000) throw Error('上游文件超过 100 MB 限制');
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0 && processed < job.requestedCount) {
            consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); if (batch.length >= 100) await flush();
          }
          if (buffer.length > 20000 && !buffer.includes('\n')) throw Error('上游数据行过长');
        }
        await flush();
      } finally { await reader.cancel().catch(() => undefined); }
      if (!processed) throw Error('上游未返回人物数据');
      await this.db.update(personaImportJobs).set({ status: this.stopped ? 'queued' : 'completed', taskToken: null, heartbeatAt: null, processed, imported, updatedAt: new Date() }).where(match);
    } catch (e) {
      await this.db.update(personaImportJobs).set({ status: 'failed', taskToken: null, heartbeatAt: null, lastError: e instanceof Error && /^(上游|导入)/.test(e.message) ? e.message : '导入失败，请检查网络后重试', updatedAt: new Date() }).where(match);
    } finally { clearInterval(beat); }
    return true;
  }
  async processEnrichment() {
    const token = randomUUID();
    const claim = await this.db.execute(sql`with picked as (select id from persona_library where status in ('queued','enriching') and (heartbeat_at is null or heartbeat_at < now()-interval '3 minutes') order by id limit 1 for update skip locked)
      update persona_library p set status='enriching',task_token=${token},heartbeat_at=now() from picked where p.id=picked.id returning p.id`);
    const id = Number(claim.rows[0]?.id); if (!id) return false;
    const match = and(eq(personaLibrary.id, id), eq(personaLibrary.taskToken, token));
    const beat = setInterval(() => { void this.db.update(personaLibrary).set({ heartbeatAt: new Date() }).where(match).catch(() => undefined); }, 15000); beat.unref();
    try {
      const row = (await this.db.select().from(personaLibrary).where(match))[0]!;
      if (!personaHubUseAllowed(process.env)) throw Error('需要有效商业授权记录');
      const settings = resolveInsightSettings((await loadPlatformSettings(this.db)).insightAgent);
      const agent = this.makeAgent ? await this.makeAgent() : new InsightAgent({ settings });
      const output = await agent.enrichPersona({ description: row.description });
      if (!output || !output.profile.occupationGroup || output.profile.confidence < 0.5) throw Error('人物结构化信息不足，需重试或更换样本');
      await this.db.update(personaLibrary).set({ profile: output.profile as unknown as Record<string, unknown>, parserVersion: output.parserVersion, model: settings.model, status: 'ready', lastError: null, taskToken: null, heartbeatAt: null, updatedAt: new Date() }).where(match);
    } catch {
      await this.db.update(personaLibrary).set({ status: 'failed', lastError: '增强未通过完整性校验，请重试；未猜测缺失人口属性', taskToken: null, heartbeatAt: null, updatedAt: new Date() }).where(match);
    } finally { clearInterval(beat); }
    return true;
  }
}
