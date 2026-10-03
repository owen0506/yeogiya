export type AlarmContext = {
  legId: string;
  mode: 'SUBWAY' | 'BUS';
  vehicleId: string;
  targetStopId: string;
  targetStopSequence: number;
  basis: 'LIVE' | 'TIMETABLE' | 'ESTIMATE';
};

export type Alarm = { destination: string; deadline: number; demo: boolean; context?: AlarmContext };
export type AlarmState = { status: 'idle' | 'active' | 'fired'; alarm: Alarm | null; busy: boolean; error: string | null };

export function readAlarm(value: unknown): Alarm | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.destination !== 'string' || !row.destination.trim() ||
      typeof row.deadline !== 'number' || !Number.isFinite(row.deadline) || typeof row.demo !== 'boolean') return null;
  const result: Alarm = { destination: row.destination, deadline: row.deadline, demo: row.demo };
  if (row.context && typeof row.context === 'object') {
    const context = row.context as Record<string, unknown>;
    if (typeof context.legId === 'string' && context.legId.trim() &&
        typeof context.vehicleId === 'string' && context.vehicleId.trim() &&
        typeof context.targetStopId === 'string' && context.targetStopId.trim() &&
        Number.isSafeInteger(context.targetStopSequence) && Number(context.targetStopSequence) >= 0 &&
        (context.mode === 'SUBWAY' || context.mode === 'BUS') &&
        (context.basis === 'LIVE' || context.basis === 'TIMETABLE' || context.basis === 'ESTIMATE')) {
      result.context = context as AlarmContext;
    }
  }
  return result;
}
