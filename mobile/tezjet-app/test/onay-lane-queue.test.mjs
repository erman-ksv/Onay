import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOnayLaneQueue } from '../lib/onay-lane-queue.ts';
test('queue projects authorized server rows, orders FIFO and discards raw location and identity fields',()=>{
 const input={queue:[{driverId:'second',position:2,availableSeats:0,lastLocation:{lat:1,lng:2},phone:'private'},{driverId:'first',position:1,availableSeats:3}]};
 assert.deepEqual(parseOnayLaneQueue(input),[{driverId:'first',position:1,availableSeats:3},{driverId:'second',position:2,availableSeats:0}]);
 assert.equal(input.queue[0].driverId,'second');
 assert.deepEqual(parseOnayLaneQueue({queue:[]}),[]);
});
test('unknown, duplicate or malformed queue never turns into a genuine empty or zero-seat proof',()=>{
 for(const input of [null,{}, {queue:null},{queue:[{driverId:'a',position:0,availableSeats:1}]},{queue:[{driverId:'a',position:1,availableSeats:-1}]},{queue:[{driverId:'a',position:1,availableSeats:9}]},{queue:[{driverId:'a',position:1,availableSeats:1},{driverId:'a',position:2,availableSeats:1}]}])assert.throws(()=>parseOnayLaneQueue(input));
});
