// The pieces more than one kind of page is made of: how a thing stands, a link
// out of the app, and a link to another of the app's views.

import { type Status, isPageClick } from "../lib/view";

/** A word for how a thing stands, with a dot in its tone's colour. The tone is
 *  an attribute rather than a class, so the five colours are one rule apiece in
 *  the stylesheet and nothing here names one. */
export function StatusWord({ status }: { status: Status }) {
  return (
    <span className="status" data-tone={status.tone}>
      {status.word}
    </span>
  );
}

/** A link out of the app. It opens in a tab of its own and tells that tab
 *  nothing about this one. */
export function OutsideLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={
        "text-ink underline decoration-accent underline-offset-[3px] hover:decoration-2 " +
        className
      }
    >
      {children}
    </a>
  );
}

/** A link to another page of this app. It is a real address, so it can be
 *  opened in a new tab, copied, and bookmarked; a plain click is answered in
 *  the page that is already open, which keeps the reader's place and their
 *  scroll. */
export function PageLink({
  href,
  onAsk,
  children,
  className = "",
  ...rest
}: {
  href: string;
  onAsk: (href: string) => void;
  children: React.ReactNode;
  className?: string;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={href}
      onClick={(e) => {
        if (!isPageClick(e)) return;
        e.preventDefault();
        onAsk(href);
      }}
      className={className}
      {...rest}
    >
      {children}
    </a>
  );
}
