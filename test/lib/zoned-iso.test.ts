import { describe, expect, it } from 'vitest';
import { cacheTtlForDate, parseZonedIso } from '../../src/lib/date';

describe('parseZonedIso', () => {
  it('accepts an explicit offset, with or without seconds', () => {
    expect(parseZonedIso('2026-09-26T11:15+05:00', 'start')).toBe(
      Date.parse('2026-09-26T06:15:00Z'),
    );
    expect(parseZonedIso('2026-09-26T06:15:20Z', 'start')).toBe(Date.parse('2026-09-26T06:15:20Z'));
  });

  it('rejects a zone-less value instead of guessing the zone', () => {
    expect(() => parseZonedIso('2026-09-26T11:15:00', 'start')).toThrow(/offset/);
    expect(() => parseZonedIso('2026-09-26', 'end')).toThrow(/offset/);
  });
});

describe('cacheTtlForDate', () => {
  it('uses 5 minutes for today and later, 1 hour for past days', () => {
    expect(cacheTtlForDate('2999-01-01', 'UTC')).toBe(300);
    expect(cacheTtlForDate('2000-01-01', 'UTC')).toBe(3600);
  });
});
