import dotenv from "dotenv";
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export const config = {
  supabaseUrl: requireEnv("SUPABASE_URL"),
  supabaseServiceKey: requireEnv("SUPABASE_SERVICE_KEY"),
  anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
} as const;
