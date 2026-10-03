const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAlarmManager } = require('../src/features/notifications/alarm-manager.ts');
const { readAlarm } = require('../src/features/notifications/alarm-types.ts');

test('a selected ride alarm retains the leg, vehicle and target stop through restoration', async () => {
  let scheduled;
  const adapter = {
    requestAlarmPermission: async () => {},
    scheduleAlarm: async alarm => { scheduled = alarm; },
    cancelAlarm: async () => {},
    restoreAlarm: async () => null,
  };
  const context = { legId: 'ride:3:6:2호선', mode: 'SUBWAY', vehicleId: '2336',
    targetStopId: 'station-문래', targetStopSequence: 2, basis: 'ESTIMATE' };
  const manager = createAlarmManager(adapter, () => 1000);
  await manager.start('합정', 300, false, context);
  assert.deepEqual(scheduled.context, context);
  assert.equal(scheduled.deadline, 301000);
  assert.deepEqual(readAlarm(JSON.parse(JSON.stringify(scheduled))), scheduled);
  assert.deepEqual(readAlarm({ ...scheduled, context: { ...context, targetStopSequence: -1 } }),
    { destination: '합정', deadline: 301000, demo: false });
});
