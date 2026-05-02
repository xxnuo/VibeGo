import { Lock, Terminal } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { authApi } from "@/api/auth";

const AUTH_KEY_STORAGE = "vibego_auth_key";

export function getStoredAuthKey(): string | null {
  return localStorage.getItem(AUTH_KEY_STORAGE);
}

export function setStoredAuthKey(key: string | null) {
  if (key) {
    localStorage.setItem(AUTH_KEY_STORAGE, key);
  } else {
    localStorage.removeItem(AUTH_KEY_STORAGE);
  }
}

interface LoginPageProps {
  onLoginSuccess: () => void;
  locale: string;
}

const t = (locale: string, key: string): string => {
  const translations: Record<string, Record<string, string>> = {
    en: {
      title: "VibeGo",
      subtitle: "Enter your access key to continue",
      placeholder: "Access Key",
      login: "Login",
      logging: "Logging in...",
      invalidKey: "Invalid access key",
      tooMany: "Too many failed attempts",
      retryIn: "Retry in",
      seconds: "s",
      remaining: "attempts remaining",
    },
    zh: {
      title: "VibeGo",
      subtitle: "请输入访问密钥以继续",
      placeholder: "访问密钥",
      login: "登录",
      logging: "登录中...",
      invalidKey: "访问密钥无效",
      tooMany: "尝试次数过多",
      retryIn: "重试等待",
      seconds: "秒",
      remaining: "次剩余尝试",
    },
  };
  return translations[locale]?.[key] || translations.en[key] || key;
};

export const LoginPage: React.FC<LoginPageProps> = ({ onLoginSuccess, locale }) => {
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState<number | null>(null);
  const [retryAfter, setRetryAfter] = useState(0);
  const [shake, setShake] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (retryAfter > 0) {
      timerRef.current = setInterval(() => {
        setRetryAfter((prev) => {
          if (prev <= 1) {
            if (timerRef.current) clearInterval(timerRef.current);
            setError("");
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }
  }, [retryAfter]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!key.trim() || loading || retryAfter > 0) return;

      setLoading(true);
      setError("");

      try {
        const res = await authApi.login(key.trim());
        if (res.ok) {
          setStoredAuthKey(key.trim());
          onLoginSuccess();
        } else {
          setShake(true);
          setTimeout(() => setShake(false), 500);
          if (res.retry_after && res.retry_after > 0) {
            setError(t(locale, "tooMany"));
            setRetryAfter(Math.ceil(res.retry_after));
            setRemaining(0);
          } else {
            setError(t(locale, "invalidKey"));
            setRemaining(res.remaining ?? null);
          }
        }
      } catch {
        setShake(true);
        setTimeout(() => setShake(false), 500);
        setError(t(locale, "invalidKey"));
      } finally {
        setLoading(false);
      }
    },
    [key, loading, retryAfter, locale, onLoginSuccess]
  );

  const isBanned = retryAfter > 0;
  const isDisabled = loading || !key.trim() || isBanned;

  return (
    <div className="fixed inset-0 z-[99999] overflow-y-auto bg-ide-bg">
      <div className="flex min-h-full w-full items-center justify-center px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="w-full max-w-sm mx-auto">
          <div className={shake ? "animate-[login-shake_0.5s_ease-in-out]" : ""}>
            <div className="text-center py-6">
              <div className="inline-flex items-center justify-center w-14 h-14 bg-ide-panel border border-ide-border rounded-2xl mb-3">
                <Terminal size={28} className="text-ide-accent" />
              </div>
              <h1 className="text-xl font-bold text-ide-text">{t(locale, "title")}</h1>
            </div>

            <div className="bg-ide-panel border border-ide-border rounded-xl p-4">
              <div className="flex items-center gap-1.5 text-xs text-ide-mute mb-3">
                <Lock size={12} />
                <span>{t(locale, "subtitle")}</span>
              </div>
              <form onSubmit={handleSubmit} className="space-y-3">
                <input
                  ref={inputRef}
                  type="password"
                  id="login-key"
                  name="key"
                  aria-label={t(locale, "placeholder")}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={t(locale, "placeholder")}
                  disabled={loading || isBanned}
                  autoComplete="current-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={Boolean(error)}
                  aria-describedby="login-feedback"
                  className={`h-11 w-full px-3 bg-ide-bg border rounded-lg text-ide-text placeholder-ide-mute text-base md:text-sm focus:outline-none transition-colors ${
                    error ? "border-red-500 focus:border-red-500" : "border-ide-border focus:border-ide-accent"
                  } ${isBanned ? "opacity-50 cursor-not-allowed" : ""}`}
                />

                <button
                  type="submit"
                  disabled={isDisabled}
                  className={`min-h-11 w-full flex items-center justify-center gap-2 px-4 rounded-lg font-medium text-sm transition-opacity ${
                    isDisabled
                      ? "bg-ide-accent/50 text-ide-bg cursor-not-allowed"
                      : "bg-ide-accent text-ide-bg hover:opacity-90 active:opacity-80"
                  }`}
                >
                  {loading ? t(locale, "logging") : t(locale, "login")}
                </button>
              </form>

              {(error || (remaining !== null && remaining > 0 && !isBanned)) && (
                <div id="login-feedback" role="status" aria-live="polite" className="mt-3 text-center text-sm">
                  {error && (
                    <div className="text-red-500">
                      {error}
                      {isBanned && (
                        <span className="ml-1 font-mono text-xs">
                          ({t(locale, "retryIn")} {retryAfter}
                          {t(locale, "seconds")})
                        </span>
                      )}
                    </div>
                  )}
                  {remaining !== null && remaining > 0 && !isBanned && (
                    <div className="text-ide-mute text-xs mt-1">
                      {remaining} {t(locale, "remaining")}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes login-shake {
          0%, 100% { transform: translateX(0); }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
          20%, 40%, 60%, 80% { transform: translateX(4px); }
        }
        input[type="password"]::-ms-reveal,
        input[type="password"]::-ms-clear,
        input[type="password"]::-webkit-credentials-auto-fill-button,
        input[type="password"]::-webkit-textfield-decoration-container {
          display: none !important;
        }
      `}</style>
    </div>
  );
};
