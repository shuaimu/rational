import { useEffect } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from './components/Layout';
import { AuthBoundary } from './components/AuthBoundary';
import { onClearProtectedState } from './api/auth';
import { subscribeSync, getSyncStatus } from './api/rxdb';
import { Dashboard } from './pages/Dashboard';
import { Performance } from './pages/Performance';
import { Transactions } from './pages/Transactions';
import { Positions } from './pages/Positions';
import { Import } from './pages/Import';
import { SnapTrade } from './pages/SnapTrade';
import { Admin } from './pages/Admin';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'always',
      staleTime: 1000 * 60, // 1 minute
      retry: 1,
    },
  },
});

const stopClear = onClearProtectedState(async () => { await queryClient.cancelQueries(); queryClient.clear(); });
if (import.meta.hot) import.meta.hot.dispose(stopClear);

function App() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribeSync(() => { if (getSyncStatus().readable) { clearTimeout(timer); timer = setTimeout(() => void queryClient.invalidateQueries(), 500); } });
    return () => { off(); clearTimeout(timer); };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthBoundary>
      <HashRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/performance" element={<Performance />} />
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/positions" element={<Positions />} />
            <Route path="/import" element={<Import />} />
            <Route path="/brokers" element={<SnapTrade />} />
            <Route path="/admin" element={<Admin />} />
          </Routes>
        </Layout>
      </HashRouter>
      </AuthBoundary>
    </QueryClientProvider>
  );
}

export default App;
