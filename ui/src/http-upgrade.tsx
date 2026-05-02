import { ArrowRight, Download, Languages, Moon, Sun } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import "@/index.css";
import { getTranslation, type Locale } from "@/lib/i18n";

const REDIRECT_DELAY_SECONDS = 30;
const DISABLE_FLAG = "--no-tls";
const CERTIFICATE_PATH = "/vibego.crt";

function detectLocale(): Locale {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("locale");
  if (requested === "zh" || requested === "en") {
    return requested;
  }

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.some((language) => language.toLowerCase().startsWith("zh")) ? "zh" : "en";
}

function buildRedirectTarget(): string {
  const current = new URL(window.location.href);
  if (current.protocol === "https:") {
    current.pathname = "/";
    current.search = "";
    current.hash = "";
    return current.toString();
  }

  current.protocol = "https:";
  return current.toString();
}

function formatTemplate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template
  );
}

function HttpUpgradePage() {
  const [locale, setLocale] = useState<Locale>(detectLocale);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
  );
  const [autoRedirect, setAutoRedirect] = useState(true);
  const [secondsRemaining, setSecondsRemaining] = useState(REDIRECT_DELAY_SECONDS);
  const redirectTarget = useMemo(buildRedirectTarget, []);

  const t = (key: string) => getTranslation(locale, key);

  useEffect(() => {
    const handleLanguageChange = () => setLocale(detectLocale());
    window.addEventListener("languagechange", handleLanguageChange);
    return () => window.removeEventListener("languagechange", handleLanguageChange);
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => setTheme(e.matches ? "dark" : "light");
    if (mediaQuery.addEventListener) mediaQuery.addEventListener("change", handleChange);
    else mediaQuery.addListener(handleChange);
    return () => {
      if (mediaQuery.removeEventListener) mediaQuery.removeEventListener("change", handleChange);
      else mediaQuery.removeListener(handleChange);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    document.title = t("httpUpgrade.title");
  }, [locale, t]);

  useEffect(() => {
    if (theme === "dark") document.documentElement.classList.add("dark");
    else document.documentElement.classList.remove("dark");
  }, [theme]);

  useEffect(() => {
    if (!autoRedirect) return;

    const timer = window.setInterval(() => {
      setSecondsRemaining((current) => {
        if (current <= 1) {
          window.clearInterval(timer);
          window.location.replace(redirectTarget);
          return 0;
        }
        return current - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [redirectTarget, autoRedirect]);

  return (
    <div className="min-h-dvh bg-ide-bg text-ide-text relative">
      <div className="mx-auto flex min-h-dvh w-full max-w-4xl items-center justify-center px-4 py-6 sm:px-6 sm:py-10">
        <Card className="w-full max-w-2xl border-ide-border bg-ide-panel py-0 shadow-sm sm:shadow-md">
          <CardHeader className="gap-3 border-b border-ide-border px-5 py-6 sm:px-8 sm:py-8">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <div className="text-xs tracking-[0.2em] text-ide-mute uppercase sm:text-sm">VibeGo</div>
                <CardTitle className="text-xl font-semibold text-ide-text sm:text-2xl">
                  {t("httpUpgrade.heading")}
                </CardTitle>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="icon" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>
                  {theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
                </Button>
                <Button variant="ghost" size="icon" onClick={() => setLocale((l) => (l === "zh" ? "en" : "zh"))}>
                  <Languages size={20} />
                </Button>
              </div>
            </div>
            <p className="text-sm leading-relaxed text-ide-mute sm:text-base">{t("httpUpgrade.description")}</p>
          </CardHeader>

          <CardContent className="space-y-6 px-5 py-6 sm:px-8 sm:py-8">
            <div className="space-y-4 text-sm leading-relaxed text-ide-mute sm:text-base">
              <p>
                <span className="font-medium text-ide-text">{t("httpUpgrade.secureContextTitle")}：</span>
                {t("httpUpgrade.secureContextDescription")}
              </p>
              <p>
                <span className="font-medium text-ide-text">{t("httpUpgrade.certificateTitle")}：</span>
                {t("httpUpgrade.certificateDescription")}
              </p>
              <p>
                <span className="font-medium text-ide-text">{t("httpUpgrade.trustTitle")}：</span>
                {t("httpUpgrade.trustDescription")}
              </p>
            </div>

            <div className="text-xs leading-relaxed text-ide-mute sm:text-sm">
              {formatTemplate(t("httpUpgrade.disableHint"), { flag: DISABLE_FLAG })}
            </div>
          </CardContent>

          <CardFooter className="flex flex-col-reverse items-stretch justify-between gap-4 border-t border-ide-border px-5 py-6 sm:flex-row sm:items-center sm:px-8 sm:py-8">
            <div className="flex items-center justify-center gap-2 text-sm text-ide-mute sm:justify-start sm:text-base">
              <Checkbox
                id="auto-redirect"
                checked={autoRedirect}
                onCheckedChange={(checked) => setAutoRedirect(!!checked)}
              />
              <label htmlFor="auto-redirect" className="cursor-pointer select-none">
                {formatTemplate(t("httpUpgrade.countdown"), { seconds: secondsRemaining })}
              </label>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              <Button
                asChild
                variant="outline"
                className="h-11 w-full border-ide-border bg-transparent px-4 text-sm text-ide-text hover:bg-ide-bg sm:h-10 sm:w-auto sm:text-base"
              >
                <a href={CERTIFICATE_PATH} download="vibego.crt" onClick={() => setAutoRedirect(false)}>
                  <Download size={16} />
                  <span>{t("httpUpgrade.installCertificate")}</span>
                </a>
              </Button>
              <Button
                asChild
                className="flex h-11 w-full items-center justify-center gap-2 bg-ide-accent px-6 text-sm text-ide-on-accent hover:opacity-90 sm:h-10 sm:w-auto sm:text-base"
              >
                <a href={redirectTarget}>
                  <span>{t("httpUpgrade.openNow")}</span>
                  <ArrowRight size={16} />
                </a>
              </Button>
            </div>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}

createRoot(document.getElementById("http-upgrade-root")!).render(<HttpUpgradePage />);
