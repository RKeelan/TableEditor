import { useLayoutEffect, useRef } from "react";
import {
  type Card,
  type ViewSection,
  dockColumns,
  isEmptySection,
} from "../lib/view";
import { CardBlock } from "./CardBlock";
import { FrozenSection } from "./FrozenSection";
import { SectionTable } from "./SectionTable";

/** What a table's overview says above it: its cards in one row, and its
 *  sections, as small tables, in a row beneath them.
 *
 *  The cards share one width and one height, set by the one that needs most,
 *  and each section is as wide as its content, the sections sharing whatever
 *  width the row has beyond that. Below 860px each row is a stack at the
 *  page's width. A section is a table at every width rather than the stack of
 *  cards a view's becomes on a phone, since a summary's are small by design.
 *
 *  The cards are in the page's own face, and the sections in the monospaced
 *  one every table is set in. */
export function Summary({
  cards,
  sections,
  onAsk,
}: {
  cards: readonly Card[];
  sections: readonly ViewSection[];
  onAsk: (href: string) => void;
}) {
  return (
    <div className="summary">
      {cards.length > 0 && (
        <div className="summary-cards">
          {cards.map((card, i) => (
            <CardBlock key={`${i}-${card.title}`} card={card} onAsk={onAsk} />
          ))}
        </div>
      )}
      {sections.length > 0 && (
        <div className="summary-sections">
          {sections.map((section, i) => (
            <SummarySection key={`${i}-${section.heading ?? ""}`} section={section} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One of the summary's sections: a small table under its heading and note,
 *  or a frozen section, which draws its own. */
function SummarySection({ section }: { section: ViewSection }) {
  if (section.freeze) {
    return (
      <div className="min-w-0">
        <FrozenSection section={section} />
      </div>
    );
  }
  return (
    <section className="min-w-0">
      {section.heading && <h3 className="text-base">{section.heading}</h3>}
      {section.note && (
        <p className="mt-1 max-w-prose text-sm text-muted">{section.note}</p>
      )}
      {isEmptySection(section) ? (
        <p className="mt-2 text-sm text-muted">None.</p>
      ) : (
        <SectionTable
          section={section}
          summary
          className={
            "font-mono text-[13px]" +
            (section.heading || section.note ? " mt-2" : "")
          }
        />
      )}
    </section>
  );
}

/** Cards in a band along the foot of the window, which stays in view however
 *  far the page above it is scrolled. The page is a column the height of the
 *  window, and the band is the last thing in it, so the page ends where the
 *  band begins and nothing is hidden behind it.
 *
 *  Each card is as wide as the widest card's content, and they sit from the
 *  left; the band's background runs the full width of the window. Below 860px
 *  they are smaller, their units left out, and wrap as many to a row as fit at
 *  the widest card's width, up to four. */
export function CardDock({
  cards,
  onAsk,
}: {
  cards: readonly Card[];
  onAsk: (href: string) => void;
}) {
  const dock = useRef<HTMLDivElement>(null);
  const band = useRef<HTMLDivElement>(null);
  // How many cards fit in a row, which the stylesheet reads below 860px. It
  // is worked out again whenever the cards are drawn, since a figure typed
  // elsewhere can widen one, and whenever the dock changes width.
  const fit = () => {
    const outer = dock.current;
    const inner = band.current;
    if (!outer || !inner) return;
    const cards = [...inner.children] as HTMLElement[];
    let widest = 0;
    for (const card of cards) {
      const width = card.style.width;
      card.style.width = "max-content";
      widest = Math.max(widest, card.getBoundingClientRect().width);
      card.style.width = width;
    }
    const style = getComputedStyle(outer);
    const available =
      outer.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const gap = parseFloat(getComputedStyle(inner).columnGap) || 0;
    inner.style.setProperty(
      "--dock-columns",
      String(dockColumns(cards.length, available, widest, gap)),
    );
  };
  useLayoutEffect(fit);
  useLayoutEffect(() => {
    const outer = dock.current;
    if (!outer) return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(outer);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={dock} className="card-dock">
      <div ref={band} className="card-dock-cards">
        {cards.map((card, i) => (
          <CardBlock key={`${i}-${card.title}`} card={card} onAsk={onAsk} />
        ))}
      </div>
    </div>
  );
}
