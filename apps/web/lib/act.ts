import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContext, type AppContext } from "./context";

/**
 * Runs a server-action body, then returns to `path` with a success or error message.
 * (redirect() must stay outside try/catch because it works by throwing.)
 */
export async function act(path: string, ok: string, work: (ctx: AppContext) => Promise<unknown>): Promise<never> {
  const ctx = await getContext();
  let error: string | null = null;
  try {
    await work(ctx);
  } catch (err) {
    error = err instanceof Error ? err.message : "Something went wrong";
  }
  revalidatePath(path);
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}${error ? `error=${encodeURIComponent(error)}` : `ok=${encodeURIComponent(ok)}`}`);
}

export function str(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

export function optional(form: FormData, key: string): string | null {
  const v = str(form, key);
  return v === "" ? null : v;
}
