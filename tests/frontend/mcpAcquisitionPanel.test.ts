import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import McpAcquisitionPanel from '../../frontend/src/components/McpAcquisitionPanel';

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
