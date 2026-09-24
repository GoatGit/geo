import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { personas, personaPools, surveyCalibrations, surveyResponses, surveys } from '@geo/db';
import { calibrateWeights, validateCalibrationInput } from '@geo/shared';
import { DB } from '../common/infra.module';
@Injectable()
export class CalibrationService {
  constructor(@Inject(DB) private readonly db: NodePgDatabase) {}
  async list(accountId: number, surveyId: number) {
    const survey = (await this.db.select({ id: surveys.id }).from(surveys).where(and(eq(surveys.id, surveyId), eq(surveys.accountId, accountId))))[0];
    if (!survey) throw new HttpException('调研不存在', 404);
    return this.db.select().from(surveyCalibrations).where(and(eq(surveyCalibrations.accountId, accountId), eq(surveyCalibrations.surveyId, surveyId))).orderBy(desc(surveyCalibrations.id)).limit(20);
  }
  async calibrate(accountId: number, surveyId: number, input: unknown) {
    return this.db.transaction(async tx => {
      const survey = (await tx.select().from(surveys).where(and(eq(surveys.id, surveyId), eq(surveys.accountId, accountId))).for('update'))[0];
      if (!survey) throw new HttpException('调研不存在', 404);
      if (!survey.activePoolId || ['draft','generating','queued','running'].includes(survey.status)) throw new HttpException('请等待作答停止后再进行真人校准', 409);
      const checked = validateCalibrationInput(input, survey.questions);
      if (!checked.ok) throw new HttpException(checked.errors.join('；'), 400);
      const rows = await tx.select({ id: personas.id, answers: surveyResponses.answers }).from(surveyResponses).innerJoin(personas, eq(personas.id, surveyResponses.personaId))
        .where(and(eq(surveyResponses.surveyId, surveyId), eq(surveyResponses.status, 'completed'), eq(personas.poolId, survey.activePoolId))).orderBy(personas.id);
      if (rows.length < 5) throw new HttpException('至少需要 5 份有效合成回答才能校准', 409);
      const result = calibrateWeights(rows, checked.value.targets);
      const [saved] = await tx.insert(surveyCalibrations).values({ accountId, surveyId, poolId: survey.activePoolId, benchmark: checked.value, result, applied: result.status === 'passed', responseCount: rows.length }).returning();
      if (result.status === 'passed') {
        // One bounded update, not N independent writes. Failed calibration never changes active weights.
        const values = sql.join(result.weights.map(r => sql`(${r.id}::bigint, ${r.weight}::real)`), sql`, `);
        await tx.execute(sql`update personas p set weight = w.weight from (values ${values}) as w(id,weight) where p.id=w.id and p.pool_id=${survey.activePoolId}`);
        await tx.update(surveyCalibrations).set({ applied: false }).where(and(eq(surveyCalibrations.poolId, survey.activePoolId), sql`${surveyCalibrations.id} <> ${saved!.id}`));
        await tx.update(personaPools).set({ activeCalibrationId: saved!.id, calibrationStatus: 'passed' }).where(eq(personaPools.id, survey.activePoolId));
      } else {
        await tx.update(personaPools).set({ calibrationStatus: 'failed' }).where(and(eq(personaPools.id, survey.activePoolId), sql`${personaPools.activeCalibrationId} is null`));
      }
      return saved;
    });
  }
}
