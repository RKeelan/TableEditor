import { type Card, type ViewSection, isEmptySection } from "../lib/view";
import { CardBlock } from "./CardBlock";
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
            <section key={`${i}-${section.heading ?? ""}`} className="min-w-0">
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
          ))}
        </div>
      )}
    </div>
  );
}
