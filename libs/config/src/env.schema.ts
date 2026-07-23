import { z } from 'zod';

/** Insecure default used only in dev/test; refused in production (see below). */
const DEV_JWT_SECRET = 'dev-insecure-secret-change-me-please';

/**
 * Canonical, validated shape of Akabbo's environment.
 *
 * Fail-closed principle (CLAUDE.md §8): the process refuses to boot on an
 * invalid/missing critical variable rather than starting in a half-configured
 * state. Provider credentials are intentionally optional in Phase 0 because
 * only STUB providers exist; later phases tighten these per provider.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    APP_ROLE: z.enum(['api', 'worker']).default('api'),

    // Cloud Run injects PORT; coerce the string env value into a number.
    PORT: z.coerce.number().int().positive().max(65535).default(8080),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // --- Database (Neon) -------------------------------------------------------
    // Required to boot. Empty schema in Phase 0, but the connection must be real
    // so the health check can prove DB reachability.
    DATABASE_URL: z.string().url().startsWith('postgres'),
    // Optional direct (non-pooled) URL for migrations; falls back to DATABASE_URL.
    DIRECT_URL: z.string().url().startsWith('postgres').optional(),

    // --- Observability ---------------------------------------------------------
    SENTRY_DSN: z.string().optional().default(''),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),

    // --- Worker ----------------------------------------------------------------
    WORKER_HEARTBEAT_MS: z.coerce.number().int().positive().default(15000),

    // Public web app origin (e.g. https://app.akabbo.com). Used to build
    // shareable invite/join links. Empty → the API returns the token + path and
    // the frontend prepends its own origin.
    PUBLIC_APP_URL: z.string().default(''),

    // --- Auth (Phase 1) --------------------------------------------------------
    // Signs session JWTs. MUST be overridden in production (guarded below).
    JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
    JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),
    OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    // Dev-only convenience: return the OTP code in the API response instead of
    // sending it (real SMS delivery of OTP arrives with Communications, Phase 3).
    AUTH_EXPOSE_OTP: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    // --- LLM (Phase 2) ---------------------------------------------------------
    // Keys are optional so the app boots with the stub; set a key + flip
    // LLM_PROVIDER to 'gemini' (Claude as fallback) to enable the real tier.
    GEMINI_API_KEY: z.string().optional().default(''),
    // `gemini-2.5-flash` is retired for new keys (404 "no longer available to
    // new users"); the current alias tracks the latest flash model. Override
    // GEMINI_MODEL to pin a specific version once one is chosen for production.
    GEMINI_MODEL: z.string().default('gemini-flash-latest'),
    ANTHROPIC_API_KEY: z.string().optional().default(''),
    // Claude fallback model (blueprint §5). Exact ID per the claude-api reference.
    ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5'),

    // --- Provider selectors ----------------------------------------------------
    // AUTH_PROVIDER is the real OTP+JWT impl. LLM_PROVIDER: 'stub' (default) |
    // 'gemini' (real, Claude fallback). SMS→3, Storage→4, Payments→5 stay stub.
    LLM_PROVIDER: z.string().default('stub'),
    // SMS (metering §6): 'stub' (default) | 'ugsms' (UGSMS v2, real reach).
    SMS_PROVIDER: z.string().default('stub'),
    UGSMS_BASE_URL: z.string().default('https://ugsms.com/api/v2'),
    UGSMS_API_KEY: z.string().default(''),
    UGSMS_SENDER_ID: z.string().default('AKABBO'),
    // Payments (metering §8): 'stub' (default) | 'muda' (Muda.tech MoMo, real
    // collections). Keys optional so the app boots on the stub.
    PAYMENT_PROVIDER: z.string().default('stub'),
    MUDA_BASE_URL: z.string().default('https://api.muda.tech/v1'),
    MUDA_OAUTH_URL: z.string().default('https://api.muda.tech/v1/clients/oauth/token'),
    MUDA_CLIENT_ID: z.string().default(''),
    MUDA_CLIENT_SECRET: z.string().default(''),
    MUDA_COLLECTION_PRODUCT_ID: z.coerce.number().default(10012),
    MUDA_WEBHOOK_SECRET: z.string().default(''),
    // Phase 4 storage. 'local' (default) writes to LOCAL_STORAGE_DIR behind the
    // same seam R2 uses in production — objects are never public either way.
    STORAGE_PROVIDER: z.string().default('local'),
    LOCAL_STORAGE_DIR: z.string().default('.akabbo-storage'),
    // Google Cloud Storage (STORAGE_PROVIDER=gcs, Phase 4 production).
    // On Cloud Run the SA email is the service identity; on dev use '' (falls to local).
    GCS_BUCKET: z.string().default(''),
    GCS_SERVICE_ACCOUNT_EMAIL: z.string().default(''),
    /** Max upload size in bytes (§31 validate size). Default 25 MB. */
    MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(25 * 1024 * 1024),
    AUTH_PROVIDER: z.string().default('local'),
  })
  // Production hardening: never boot prod with dev-grade auth (§8 fail-closed).
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (env.JWT_SECRET === DEV_JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET must be set to a strong secret in production',
      });
    }
    if (env.AUTH_EXPOSE_OTP) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_EXPOSE_OTP'],
        message: 'AUTH_EXPOSE_OTP must be false in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Validate a raw environment object (defaults to process.env).
 * Throws a readable, aggregated error listing every invalid/missing var.
 */
export function validateEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration. Fix these variables (see .env.example):\n${issues}`,
    );
  }
  return parsed.data;
}
