// The Postgres schema the app's tables and functions live in on the hosted Supabase project.
// After the move to the Gleeday project they live in "partners" instead of "public".
// Every Supabase client (browser, server, service) must pass { db: { schema: DB_SCHEMA } }.
export const DB_SCHEMA = "partners" as const;
