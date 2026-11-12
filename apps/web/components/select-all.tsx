"use client";

/** Ticks or clears every checkbox named "pick" in the same form. */
export function SelectAll() {
  return (
    <label className="check small">
      <input
        type="checkbox"
        onChange={(e) => {
          const form = e.currentTarget.form;
          form?.querySelectorAll<HTMLInputElement>('input[name="pick"]').forEach((c) => { c.checked = e.currentTarget.checked; });
        }}
      />{" "}
      Select all
    </label>
  );
}
