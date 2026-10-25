import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import McpAcquisitionPanel from '../../frontend/src/components/McpAcquisitionPanel';
import { acquisitionOperationStatus, executeAcquisitionOperation } from '../../frontend/src/services/acquisitionService';
import { apiPost } from '../../frontend/src/utils/fetchInterceptor';

let mockIsAdmin = false;
jest.mock('../../frontend/src/contexts/AuthContext', () => ({
  useAuth: () => ({ auth: { user: { isAdmin: mockIsAdmin } } }),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback: string) => fallback || key }) }));
jest.mock('../../frontend/src/utils/fetchInterceptor', () => ({ apiGet: jest.fn(), apiPost: jest.fn() }));

test('hides acquisition review from non-admin users', () => {
  mockIsAdmin = false;
  expect(renderToStaticMarkup(createElement(McpAcquisitionPanel))).toBe('');
});
test('explains catalog evidence and exposes no install action before plan review', () => {
  mockIsAdmin = true;
  const html = renderToStaticMarkup(createElement(McpAcquisitionPanel));
  expect(html).toContain('Find a missing capability');
  expect(html).toContain('do not install anything');
  expect(html).not.toContain('Save authorization');
});

test('operation messaging distinguishes authorization, queueing and activation without claiming readiness',()=>{
  expect(acquisitionOperationStatus({operation_id:'op',state:'authorized'}).text).toContain('Start installation');
  expect(acquisitionOperationStatus({operation_id:'op',state:'authorized',execution_started:true}).text).toContain('Queued');
  expect(acquisitionOperationStatus({operation_id:'op',state:'verifying',publication_applied_at:'now'}).text).toContain('Starting');
  expect(acquisitionOperationStatus({operation_id:'op',state:'verifying',verification:'functional',cancel_requested:true}).text).toContain('Cancellation');
  expect(acquisitionOperationStatus({operation_id:'op',state:'failed',requires_reconciliation:true}).text).toContain('review');
});
test('execution sends credentials only to the owner-scoped operation endpoint',async()=>{
  (apiPost as jest.Mock).mockResolvedValue({success:true,data:{status:'accepted'}});
  await executeAcquisitionOperation('op/path',{API_KEY:'synthetic-value'});
  expect(apiPost).toHaveBeenCalledWith('/market/acquisition/operations/op%2Fpath/execute',{credentials:{API_KEY:'synthetic-value'}});
});
