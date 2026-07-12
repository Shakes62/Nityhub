import type { ReactNode } from "react";

interface PageHeroProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
}

/**
 * De-boxed page header: title + description with right-aligned actions, an
 * optional badges/children row, and a hairline separating it from the content.
 */
export function PageHero({ title, description, actions, children }: PageHeroProps) {
  return (
    <div className="border-b border-border pb-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight text-ink">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 text-sm text-muted">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}
