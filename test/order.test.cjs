const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const start = source.indexOf('function sortedTransactions() {');
const end = source.indexOf('\nfunction selectedTransactions()', start);
assert.ok(start >= 0 && end > start, 'sortedTransactions must be present in app.js');
const sortingCode = source.slice(start, end);

function sort(items) {
  const context = { data: { transactions: items } };
  return vm.runInNewContext(sortingCode + '\nsortedTransactions()', context);
}

test('recent registration wins over a future movement date', () => {
  const items = [
    { id: 'future', date: '2026-10-31', createdAt: '2026-10-04T19:30:31.000Z' },
    { id: 'today', date: '2026-10-06', createdAt: '2026-10-07T00:23:47.000Z' },
    { id: 'older', date: '2026-10-03' }
  ];
  assert.deepEqual(Array.from(sort(items), (item) => item.id), ['today', 'future', 'older']);
});

test('rows registered together follow their captured time and keep ties stable', () => {
  const createdAt = '2026-10-07T00:23:47.000Z';
  const items = [
    { id: 'afternoon-a', date: '2026-10-06', createdAt, note: 'Hora: 15:34' },
    { id: 'evening', date: '2026-10-06', createdAt, note: 'Hora: 21:20' },
    { id: 'afternoon-b', date: '2026-10-06', createdAt, note: 'Hora: 15:34' },
    { id: 'unknown', date: '2026-10-06', createdAt }
  ];
  assert.deepEqual(Array.from(sort(items), (item) => item.id), ['evening', 'afternoon-a', 'afternoon-b', 'unknown']);
});
