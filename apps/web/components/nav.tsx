"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS: { title?: string; links: { href: string; label: string }[] }[] = [
  { links: [{ href: "/", label: "Today" }, { href: "/metrics", label: "Metrics" }] },
  {
    title: "Pipelines",
    links: [
      { href: "/pipelines/affiliates", label: "Affiliates" },
      { href: "/pipelines/co_marketing", label: "Co-Marketing" },
      { href: "/pipelines/media_pr", label: "Media & PR" },
      { href: "/pipelines/listings", label: "Listings" },
    ],
  },
  {
    title: "Work",
    links: [
      { href: "/approvals", label: "Approvals" },
      { href: "/tasks", label: "Tasks" },
      { href: "/exceptions", label: "Exceptions" },
    ],
  },
  {
    title: "System",
    links: [
      { href: "/bots", label: "Bots" },
      { href: "/integrations", label: "Integrations & sources" },
      { href: "/settings/import", label: "Import data" },
      { href: "/settings", label: "Settings" },
    ],
  },
];

export function Nav({ counts }: { counts: { approvals: number; exceptions: number } }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : href === "/settings" ? path === "/settings" : path === href || path.startsWith(`${href}/`));
  const badge = (href: string) =>
    href === "/approvals" && counts.approvals ? counts.approvals
    : href === "/exceptions" && counts.exceptions ? counts.exceptions
    : null;
  return (
    <nav className="nav" aria-label="Main">
      {SECTIONS.map((s, i) => (
        <div className="nav-section" key={i}>
          {s.title ? <div className="nav-title">{s.title}</div> : null}
          {s.links.map((l) => (
            <Link key={l.href} href={l.href} className={isActive(l.href) ? "active" : undefined} aria-current={isActive(l.href) ? "page" : undefined}>
              <span>{l.label}</span>
              {badge(l.href) ? <span className="nav-badge">{badge(l.href)}</span> : null}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
