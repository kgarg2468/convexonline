/** Inline wordmark glyph so the rail never depends on a network fetch. */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="#245B50" />
      <path d="M7 21.5h18" stroke="#E9F1EE" strokeWidth="2.2" strokeLinecap="round" />
      <path
        d="M9 21.5v-7.5a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v7.5"
        fill="none"
        stroke="#E9F1EE"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="8.5" r="1.6" fill="#E9F1EE" />
    </svg>
  );
}
