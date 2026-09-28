import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { cacheKey, getCached } from '../../lib/cache';
import {
  assertIsoDate,
  cacheTtlForDate,
  cacheTtlForInstant,
  normalizeRange,
  parseZonedIso,
} from '../../lib/date';
import { toolErrorResult, UnsupportedOperationError } from '../../lib/errors';
import type { HealthProvider } from '../../providers/types';
import { HeartRateDaySchema, HrResolutionSchema, IntradayDetailLevel } from '../../providers/types';

export function registerHeartReadTools(
  server: McpServer,
  provider: HealthProvider,
  env: Env,
): void {
  server.registerTool(
    'get_heart_rate_range',
    {
      title: 'Heart rate across a date range',
      description:
        'Daily resting heart rate and time-in-zone for each day in the range. Cached 1h.',
      inputSchema: {
        start: z.string().describe('YYYY-MM-DD'),
        end: z.string().describe('YYYY-MM-DD'),
      },
      outputSchema: { days: z.array(HeartRateDaySchema) },
    },
    async ({ start, end }) => {
      try {
        const range = normalizeRange(start, end);
        const days = await getCached(
          env,
          cacheKey('get_heart_rate_range', range),
          () => provider.getHeartRateRange(range.start, range.end),
          { ttlSec: cacheTtlForDate(range.end) },
        );
        return {
          structuredContent: { days },
          content: [{ type: 'text', text: JSON.stringify(days, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_heart_rate_intraday',
    {
      title: 'Intraday heart rate for one day',
      description:
        'Heart-rate series for one local day, 00:00 to 24:00 in the user timezone. Every point has time_utc and time_local (ISO 8601 with offset). ' +
        'Real sampling: the device stores raw points about every 1-5 s during a workout and less often at rest. ' +
        '1sec returns these raw points as they are (a full day is 20-30k points) and adds no extra precision; 1min/5min/15min return per-bucket avg (bpm), min, max and sample count. ' +
        'Use 1min for day views. For a workout or a short window use get_exercise_heart_rate or get_heart_rate_range_intraday. ' +
        'Past days are cached 1h, today 5 min. If `points` is empty, use get_heart_rate_range for resting heart rate.',
      inputSchema: {
        date: z.string().describe('YYYY-MM-DD, a local date in the user timezone.'),
        detailLevel: IntradayDetailLevel.describe(
          '1sec = raw samples; 1min / 5min / 15min = bucket averages.',
        ),
      },
    },
    async ({ date, detailLevel }) => {
      try {
        assertIsoDate(date, 'date');
        const data = await getCached(
          env,
          cacheKey('get_heart_rate_intraday.v2', { date, detailLevel }),
          () => provider.getHeartRateIntraday(date, detailLevel),
          { ttlSec: cacheTtlForDate(date) },
        );
        return seriesResult(data);
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_heart_rate_range_intraday',
    {
      title: 'Heart rate for a time window',
      description:
        'Heart-rate series between two instants, at most 24 hours apart. start and end are ISO 8601 with an offset, e.g. 2026-09-26T11:15:00+05:00. ' +
        'resolution raw returns every stored sample (about every 1-5 s in a workout); 5s / 15s / 1min return per-bucket avg (bpm), min, max and sample count. ' +
        'Every point has time_utc and time_local. The summary gives avg, min, max, point count and the median interval between raw points. ' +
        'Windows that end before today are cached 1h, others 5 min.',
      inputSchema: {
        start: z.string().describe('ISO 8601 with offset, e.g. 2026-09-26T11:15:00+05:00'),
        end: z.string().describe('ISO 8601 with offset. At most 24 hours after start.'),
        resolution: HrResolutionSchema.optional().describe(
          '1min (default), 15s, 5s or raw. Use raw or 5s only for short windows.',
        ),
      },
    },
    async ({ start, end, resolution }) => {
      try {
        const getSeries = provider.getHeartRateSeries?.bind(provider);
        if (!getSeries) throw unsupported('get_heart_rate_range_intraday');
        const res = resolution ?? '1min';
        const data = await getCached(
          env,
          cacheKey('get_heart_rate_range_intraday', { start, end, resolution: res }),
          () => getSeries(start, end, res),
          { ttlSec: cacheTtlForInstant(parseZonedIso(end, 'end')) },
        );
        return seriesResult(data);
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_exercise_heart_rate',
    {
      title: 'Heart rate for one workout',
      description:
        'Heart-rate series and summary for one workout from get_exercise_list. Pass exerciseId (preferred), or logId plus the workout date. ' +
        'Returns workout metadata (type, start/end in UTC and local time, active duration, distance, calories), the series, ' +
        'a summary (avg, min, max, point count, median interval between raw points), time in zones, pause/stop events and laps when the workout has them. ' +
        'Zones: `google` = zone durations that Google reports for the workout; `computed` = Bevel-style zones by percent of max heart rate (default max = 220 - age, override with max_hr). ' +
        'padding_minutes adds context before and after the workout to the series only; the summary and zones cover the workout itself.',
      inputSchema: {
        exerciseId: z.string().optional().describe('exerciseId from get_exercise_list.'),
        logId: z.number().int().optional().describe('Numeric logId from get_exercise_list.'),
        date: z
          .string()
          .optional()
          .describe('YYYY-MM-DD of the workout. Speeds up a logId lookup.'),
        resolution: HrResolutionSchema.optional().describe('raw (default), 5s, 15s or 1min.'),
        padding_minutes: z.number().int().min(0).max(120).optional().describe('Default 0.'),
        max_hr: z
          .number()
          .int()
          .min(100)
          .max(240)
          .optional()
          .describe('Maximum heart rate for computed zones. Default 220 - age.'),
      },
    },
    async ({ exerciseId, logId, date, resolution, padding_minutes, max_hr }) => {
      try {
        const getExerciseHr = provider.getExerciseHeartRate?.bind(provider);
        if (!getExerciseHr) throw unsupported('get_exercise_heart_rate');
        if (date) assertIsoDate(date, 'date');
        const opts = {
          resolution: resolution ?? 'raw',
          paddingMinutes: padding_minutes ?? 0,
          maxHr: max_hr,
        };
        const ref = { exerciseId, logId, date };
        const data = await getCached(
          env,
          cacheKey('get_exercise_heart_rate', { ...ref, ...opts }),
          () => getExerciseHr(ref, opts),
          { ttlSec: date ? cacheTtlForDate(date) : 300 },
        );
        return seriesResult(data);
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}

/**
 * Series payloads can hold tens of thousands of points. So they go out once,
 * as compact JSON text: no `structuredContent` copy and no output-schema check,
 * which would double the size and add CPU time on a free-plan Worker.
 */
function seriesResult(data: object) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function unsupported(tool: string): UnsupportedOperationError {
  return new UnsupportedOperationError(
    `${tool} needs the Google Health provider.`,
    'Set HEALTH_PROVIDER = "google" in wrangler.toml.',
  );
}
