import type { AcquisitionPlanDb } from './mcpAcquisitionPlan.js';

/** pg adapters return rows; TypeORM PostgreSQL UPDATE/DELETE return [rows, affected]. */
export function acquisitionRowsDatabase(db: AcquisitionPlanDb): AcquisitionPlanDb {
  return { query: async (sql, parameters) => {
    const result = await db.query(sql, parameters);
    if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
      return result[0];
    }
    if (!Array.isArray(result)) throw new Error('Unexpected acquisition database result');
    return result;
  } };
}
