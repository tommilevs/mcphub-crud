import { assertJsonDaoTransactionAccess, serializeJsonDao, withJsonDaoTransaction } from '../../src/services/jsonDaoTransaction.js';

test('serializes whole operations across async boundaries and supports nested DAO calls', async () => {
  let value = 0;
  class Dao {
    async read() { return value; }
    async add() { const previous = await this.read(); await Promise.resolve(); value = previous + 1; }
    syncHelper() { return 'unchanged'; }
  }
  const dao = serializeJsonDao(new Dao());
  await Promise.all(Array.from({ length: 10 }, () => dao.add()));
  expect(value).toBe(10); expect(dao.syncHelper()).toBe('unchanged');
  const spy = jest.spyOn(dao, 'read').mockResolvedValue(42);
  expect(await dao.read()).toBe(42); expect(spy).toHaveBeenCalled(); spy.mockRestore();
});

test('rejects non-participating synchronous writes while another async operation owns the transaction', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = withJsonDaoTransaction(async () => {
    entered(); await new Promise<void>(resolve => { release = resolve; });
    assertJsonDaoTransactionAccess();
  });
  await started;
  expect(() => assertJsonDaoTransactionAccess()).toThrow('conflicts');
  release(); await pending;
  expect(() => assertJsonDaoTransactionAccess()).not.toThrow();
});

test('an exception releases the queue for subsequent requests', async () => {
  await expect(withJsonDaoTransaction(() => { throw new Error('fixture'); })).rejects.toThrow('fixture');
  await expect(withJsonDaoTransaction(() => 'next')).resolves.toBe('next');
});
