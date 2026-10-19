import type { IconName } from "@/lib/agenda/status";

const PATHS: Record<IconName, React.ReactNode> = {
  check: <path d="M5 13l4 4L19 7" />,
  person: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  repeat: <path d="M17 2l4 4-4 4M3 11V9a3 3 0 013-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 01-3 3H3" />,
  package: <path d="M21 8l-9-5-9 5v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8" />,
  calendar: <path d="M3 5h18v16H3zM3 10h18M8 3v4M16 3v4" />,
  lock: <path d="M6 11h12v9H6zM8 11V8a4 4 0 018 0v3" />,
  alert: <path d="M12 3l10 18H2L12 3zM12 10v5M12 18v.01" />,
  x: <><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></>,
};

export function StatusIcon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      {PATHS[name]}
    </svg>
  );
}
