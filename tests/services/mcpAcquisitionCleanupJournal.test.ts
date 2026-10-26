import {AcquisitionCleanupJournal} from '../../src/services/mcpAcquisitionCleanupJournal.js';

test('cleanup rejects caller-controlled identifiers, steps and review reasons before storage',async()=>{
  const query=jest.fn(); const journal=new AcquisitionCleanupJournal({query});
  const id='00000000-0000-4000-8000-000000000001';
  await expect(journal.claim('alice','../package')).rejects.toThrow('cleanup');
  await expect(journal.recordStep('alice',id,id,'other' as any)).rejects.toThrow('cleanup');
  await expect(journal.requireReview('alice',id,id,'secret-value' as any)).rejects.toThrow('cleanup');
  for(const input of ['../KEY','__proto__','constructor','KEY\0VALUE'])
    await expect(journal.recordSecret('alice',id,id,input)).rejects.toThrow('cleanup');
  expect(query).not.toHaveBeenCalled();
});

test('TypeORM zero affected rows cannot confirm cleanup receipts',async()=>{
  const journal=new AcquisitionCleanupJournal({query:jest.fn().mockResolvedValue([[],0])});
  const id='00000000-0000-4000-8000-000000000001';
  expect(await journal.recordStep('alice',id,id,'files')).toBe(false);
});

test('zero affected rows cannot confirm a credential deletion receipt',async()=>{
  const journal=new AcquisitionCleanupJournal({query:jest.fn().mockResolvedValue([[],0])});
  const id='00000000-0000-4000-8000-000000000001';
  expect(await journal.recordSecret('alice',id,id,'API_KEY')).toBe(false);
});
