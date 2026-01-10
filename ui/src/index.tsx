import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/index.css'
import App from '@/App.tsx'

const isCancelError = (error: unknown): boolean => {
  if (error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  if (error && typeof error === 'object') {
    const e = error as { name?: string; message?: string };
    return e.name === 'CanceledError' ||
           e.name === 'Canceled' ||
           e.message === 'Canceled' ||
           (typeof e.message === 'string' && (
             e.message.includes('canceled') ||
             e.message.includes('Canceled') ||
             e.message.includes('aborted')
           ));
  }
  return false;
};

window.addEventListener('error', (e) => {
  const msg = e.message || '';
  const filename = e.filename || '';
  if ((isCancelError(e.error) || msg.includes('Canceled') || msg.includes('canceled')) &&
    (filename.includes('monaco') || filename.includes('editor') || filename.includes('installHook'))
  ) {
    e.preventDefault();
    return true;
  }
});

window.addEventListener('unhandledrejection', (e) => {
  if (isCancelError(e.reason)) {
    e.preventDefault();
  }
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 1,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
