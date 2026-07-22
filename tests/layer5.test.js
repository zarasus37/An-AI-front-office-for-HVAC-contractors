/**
 * Layer 5 — Lifecycle Automation Tests
 * Tests: RenewalOutreachEngine, RouteCluster, extractZip, buildRenewalSchedule
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { RouteCluster, extractZip, buildRenewalSchedule } from '../src/lifecycle/renewal.js';

describe('extractZip', () => {

  test('extracts 5-digit ZIP from address', () => {
    assert.strictEqual(extractZip('123 Main St, Austin, TX 78701'), '78701');
    assert.strictEqual(extractZip('456 Oak Ave, Houston TX 77001-1234'), '77001');
    assert.strictEqual(extractZip('No zip here'), null);
    assert.strictEqual(extractZip(null), null);
    assert.strictEqual(extractZip(''), null);
  });

  test('extracts first ZIP when multiple appear', () => {
    assert.strictEqual(extractZip('123 Main St Austin TX 78701 near 90210'), '78701');
  });
});

describe('RouteCluster — clusterByZip', () => {

  test('groups customers by zip code', () => {
    const customers = [
      { id: '1', service_address: '123 Oak St, Austin TX 78701' },
      { id: '2', service_address: '456 Elm St, Austin TX 78702' },
      { id: '3', service_address: '789 Pine St, Dallas TX 75201' },
    ];

    const schedule = RouteCluster.clusterByZip(customers, { maxPerZipPerDay: 2 });

    // 78701: 2 customers, maxPerZip=2 → ceil(2/2)=1 day bucket
    assert.strictEqual(schedule.get('78701')?.length, 1);
    // 75201: 1 customer → ceil(1/2)=1 day bucket
    assert.strictEqual(schedule.get('75201')?.length, 1);
    // 78702: 1 customer → ceil(1/2)=1 day bucket
    assert.strictEqual(schedule.get('78702')?.length, 1);
  });

  test('handles missing addresses gracefully', () => {
    const customers = [
      { id: '1', service_address: '123 Oak St, Austin TX 78701' },
      { id: '2', service_address: null },
      { id: '3' },  // no address field
    ];

    const schedule = RouteCluster.clusterByZip(customers);
    assert.strictEqual(schedule.get('78701')?.length, 1);
    assert.strictEqual(schedule.size, 1);
  });

  test('respects maxPerZipPerDay limit', () => {
    const customers = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      service_address: `100 ${i} St, Austin TX 7870${i % 2}`, // alternating zips
    }));

    const schedule = RouteCluster.clusterByZip(customers, { maxPerZipPerDay: 3 });
    for (const [, days] of schedule) {
      for (const { customers: dayCustomers } of days) {
        assert.ok(dayCustomers.length <= 3, `day exceeds max: ${dayCustomers.length}`);
      }
    }
  });
});

describe('RouteCluster — flatten', () => {

  test('flattens schedule into customer list with scheduledDay', () => {
    const customers = [
      { id: '1', service_address: '123 Oak St, Austin TX 78701' },
      { id: '2', service_address: '456 Elm St, Austin TX 78701' },
    ];

    const schedule = RouteCluster.clusterByZip(customers, { maxPerZipPerDay: 1 });
    const flat = RouteCluster.flatten(schedule);

    assert.strictEqual(flat.length, 2);
    assert.ok(flat.every(c => typeof c.scheduledDay === 'number'));
  });
});

describe('buildRenewalSchedule', () => {

  test('distributes customers across days respecting maxPerDay', () => {
    const customers = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      service_address: `${100+i} St, Austin TX 7870${i % 3}`,
    }));

    const scheduled = buildRenewalSchedule(customers, { maxPerDay: 10, maxPerZipPerDay: 5 });

    const byDay = new Map();
    for (const c of scheduled) {
      if (!byDay.has(c.scheduledDay)) byDay.set(c.scheduledDay, 0);
      byDay.set(c.scheduledDay, byDay.get(c.scheduledDay) + 1);
    }

    for (const [day, count] of byDay) {
      assert.ok(count <= 10, `Day ${day} has ${count} > maxPerDay 10`);
    }
  });

  test('assigns all customers a scheduledDay', () => {
    const customers = [
      { id: '1', service_address: '123 Oak St, Austin TX 78701' },
      { id: '2', service_address: '456 Elm St, Dallas TX 75201' },
      { id: '3', service_address: '789 Pine St, Houston TX 77001' },
    ];

    const scheduled = buildRenewalSchedule(customers, { maxPerDay: 2 });
    assert.strictEqual(scheduled.length, 3);
    assert.ok(scheduled.every(c => c.scheduledDay >= 1));
  });

  test('includes zip in each scheduled customer', () => {
    const customers = [
      { id: '1', service_address: '123 Oak St, Austin TX 78701' },
    ];

    const scheduled = buildRenewalSchedule(customers);
    assert.strictEqual(scheduled[0].zip, '78701');
  });
});
