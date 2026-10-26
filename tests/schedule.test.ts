import test from 'node:test';
import assert from 'node:assert/strict';
import {describeSchedule,dueAt,nextRun,parseCron,scheduled,shortestGap,toScheduled,type Schedule} from '../packages/contracts/src/schedule.js';

const at=(d:number,h:number,m:number)=>new Date(2026,9,d,h,m).getTime();  // October 2026; the 19th is a Monday
const times=(t:string[],days:number[]=[]):Schedule=>({kind:'times',times:t,days});
const cron=(expression:string):Schedule=>({kind:'cron',expression});

test('set times run at the next listed time on an allowed day',()=>{
  assert.equal(nextRun(times(['04:00']),at(20,3,59)),at(20,4,0));
  assert.equal(nextRun(times(['04:00']),at(20,4,0)),at(21,4,0));  // Strictly after
  assert.equal(nextRun(times(['16:30','04:00']),at(20,5,0)),at(20,16,30));
  assert.equal(nextRun(times(['04:00'],[1,3,5]),at(20,5,0)),at(21,4,0));  // Tue → Wed
  assert.equal(nextRun(times(['04:00'],[1]),at(19,5,0)),at(26,4,0));  // A week on
});
test('cron fields take values, ranges, lists, steps and names',()=>{
  assert.equal(nextRun(cron('*/15 * * * *'),at(20,4,1)),at(20,4,15));
  assert.equal(nextRun(cron('0 4 * * mon-fri'),at(23,5,0)),at(26,4,0));  // Fri → Mon
  assert.equal(nextRun(cron('30 3 1 * *'),at(20,0,0)),new Date(2026,10,1,3,30).getTime());
  assert.equal(nextRun(cron('0 0 * * 7'),at(20,0,0)),at(25,0,0));  // 7 is Sunday
  assert.equal(nextRun(cron('@daily'),at(20,1,0)),at(21,0,0));
  // Both day fields set: either matches, as cron has it.
  assert.equal(nextRun(cron('0 0 31 * 1'),at(20,0,0)),at(26,0,0));
  assert.equal(nextRun(cron('0 0 30 2 *'),at(20,0,0)),undefined);
  for(const bad of ['* * * *','61 * * * *','* * * * 8','*/0 * * * *','5-1 * * * *','x * * * *'])assert.throws(()=>parseCron(bad),Error,bad);
});
test('a job is due for its latest missed time, within the late window, once',()=>{
  const daily=times(['04:00']);
  assert.equal(dueAt(daily,undefined,at(20,4,30),2*3600000),at(20,4,0));
  assert.equal(dueAt(daily,at(20,4,1),at(20,5,0),2*3600000),undefined);  // Already ran
  assert.equal(dueAt(daily,at(19,4,1),at(20,7,0),2*3600000),undefined);  // Too late
  assert.equal(dueAt(times(['04:00','05:00']),at(19,4,1),at(20,5,30),2*3600000),at(20,5,0));
  assert.equal(dueAt({kind:'every',minutes:60},at(20,4,0),at(20,4,59)),undefined);
  assert.equal(dueAt({kind:'every',minutes:60},at(20,4,0),at(20,5,0)),at(20,5,0));
  assert.equal(dueAt({kind:'every',minutes:60},undefined,at(20,5,0))!<=at(20,5,0),true);  // Never ran: due now
});
test('a schedule may run no more often than its job allows',()=>{
  assert.equal(shortestGap(times(['04:00','04:30'])),30);
  assert.equal(shortestGap(times(['23:50','00:10'])),20);  // Across midnight
  assert.equal(shortestGap(cron('0 */6 * * *')),360);
  const hourly=scheduled(60);
  assert.equal(hourly.safeParse({enabled:true,schedule:cron('*/5 * * * *')}).success,false);
  assert.equal(hourly.safeParse({enabled:true,schedule:cron('0 30 2 *')}).success,false);
  assert.equal(hourly.safeParse({enabled:true,schedule:cron('0 0 30 2 *')}).success,false);  // Never runs
  assert.equal(hourly.safeParse({enabled:true,schedule:times([])}).success,false);
  assert.equal(hourly.safeParse({enabled:true,schedule:times(['04:00'],[1,2])}).success,true);
});
test('schedules saved as a daily time or every N minutes read as schedules',()=>{
  assert.deepEqual(toScheduled({enabled:true,time:'03:30'}),{enabled:true,schedule:times(['03:30'])});
  assert.deepEqual(toScheduled({enabled:false,minutes:20}),{enabled:false,schedule:{kind:'every',minutes:20}});
  assert.deepEqual(scheduled(5).parse({enabled:true,minutes:20}),{enabled:true,schedule:{kind:'every',minutes:20}});
});
test('a schedule reads as a short line',()=>{
  assert.equal(describeSchedule({kind:'every',minutes:360}),'Every 6 hours');
  assert.equal(describeSchedule({kind:'every',minutes:1440}),'Every day');
  assert.equal(describeSchedule(times(['16:00','04:00'],[1,2,3,4,5])),'Weekdays at 04:00 and 16:00');
  assert.equal(describeSchedule(times(['04:00'],[0,3])),'Sun, Wed at 04:00');
  assert.equal(describeSchedule(cron('0 4 1 * *')),'Cron 0 4 1 * *');
});
