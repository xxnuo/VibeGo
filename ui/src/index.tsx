
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@/index.css";
import "@/lib/monaco";
import "@fontsource-variable/jetbrains-mono";
import App from "@/App.tsx";

const isCancelError = (error: unknown): boolean => {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (error && typeof error === "object") {
    const e = error as { name?: string; message?: string };
    return (
      e.name === "CanceledError" ||
      e.name === "Canceled" ||
      e.message === "Canceled" ||
      (typeof e.message === "string" &&
        (e.message.includes("canceled") ||
          e.message.includes("Canceled") ||
          e.message.includes("aborted")))
    );
  }
  return false;
};

const originalConsoleError = console.error;
console.error = function (...args) {
  // Check if any argument is a Canceled error related to Monaco/Editor
  const shouldIgnore = args.some((arg) => {
    const str =
      arg instanceof Error
        ? arg.message + (arg.stack || "")
        : typeof arg === "string"
          ? arg
          : "";

    return (
      (str.includes("Canceled") ||
        str.includes("canceled") ||
        str.includes("aborted")) &&
      (str.includes("monaco") ||
        str.includes("editor") ||
        str.includes("installHook") ||
        str.includes("DeferredPromise") ||
        str.includes("HTMLBodyElement.handler"))
    );
  });

  if (shouldIgnore) return;
  originalConsoleError.apply(console, args);
};

window.addEventListener(
  "error",
  (e) => {
    const msg = e.message || "";
    const filename = e.filename || "";
    if (
      (isCancelError(e.error) ||
        msg.includes("Canceled") ||
        msg.includes("canceled")) &&
      (filename.includes("monaco") ||
        filename.includes("editor") ||
        filename.includes("installHook"))
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return true;
    }
  },
  true,
);

window.addEventListener("unhandledrejection", (e) => {
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
});

createRoot(document.getElementById("root")!).render(
  // StrictMode causes double-mounting in dev, which can trigger Monaco cancellation errors
  // removing it helps stabilize the editor init sequence
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
