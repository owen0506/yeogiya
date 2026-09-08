export type Alarm = { destination: string; deadline: number; demo: boolean };
export type AlarmState = { status: 'idle' | 'active' | 'fired'; alarm: Alarm | null; busy: boolean; error: string | null };
