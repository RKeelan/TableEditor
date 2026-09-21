import { type Card, type CardGroup, isQuiet, linkHref } from "../lib/view";
import { PageLink, StatusWord } from "./parts";

interface Props {
  groups: readonly CardGroup[];
  onAsk: (href: string) => void;
}

/** Groups of cards: one heading and its count, then the cards under it, three
 *  across on a desktop and one on a phone.
 *
 *  A group the server sent has something in it — an empty one is dropped before
 *  it is sent — so nothing here says "none". */
export function CardGrid({ groups, onAsk }: Props) {
  return (
    <>
      {groups.map((group, i) => (
        <section key={`${i}-${group.heading}`} className="mb-10 last:mb-2">
          <div className="mb-3 flex items-baseline gap-2">
            <h3 className="text-base">{group.heading}</h3>
            <span className="text-muted">{group.cards.length}</span>
          </div>
          <div className="grid grid-cols-1 gap-4 min-[620px]:grid-cols-2 min-[940px]:grid-cols-3">
            {group.cards.map((card, j) => (
              <CardBlock key={`${j}-${card.title}`} card={card} onAsk={onAsk} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

const SURFACE =
  "block rounded-lg border border-border bg-surface px-4 pt-3.5 pb-4 text-ink no-underline";

function CardBlock({
  card,
  onAsk,
}: {
  card: Card;
  onAsk: (href: string) => void;
}) {
  const statuses = card.statuses ?? [];
  const rows = card.rows ?? [];
  // A card whose statuses are all neutral is on the page as a fact rather than
  // as something waiting to be done about, so its title reads quieter.
  const quiet = isQuiet(statuses);

  const body = (
    <>
      {(statuses.length > 0 || card.identifier !== undefined) && (
        <div className="mb-2.5 flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            {statuses.map((status, i) => (
              <StatusWord key={`${i}-${status.word}`} status={status} />
            ))}
          </span>
          {card.identifier !== undefined && (
            <span className="shrink-0 font-mono text-[0.8125rem] text-muted">
              {card.identifier}
            </span>
          )}
        </div>
      )}

      <h4 className={"text-[1.05rem]" + (quiet ? " text-muted" : "")}>
        {card.title}
      </h4>
      {card.subtitle !== undefined && (
        <p className="mt-1 text-sm text-muted">{card.subtitle}</p>
      )}

      {rows.length > 0 && (
        <dl className="mt-3.5 grid gap-1.5 border-t border-border pt-3">
          {rows.map((row, i) => (
            <div
              key={`${i}-${row.label}`}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              {/* A label can be a publication's name, long enough to want the
                  wrap a fixed label does not get. */}
              <dt className="min-w-0 break-words text-muted">{row.label}</dt>
              <dd className="min-w-0 break-words text-right">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {card.sentence !== undefined && (
        <p className="mt-3 text-sm text-muted">{card.sentence}</p>
      )}
    </>
  );

  if (!card.link) return <div className={SURFACE}>{body}</div>;
  return (
    <PageLink
      href={linkHref(card.link)}
      onAsk={onAsk}
      className={SURFACE + " hover:border-muted"}
    >
      {body}
    </PageLink>
  );
}
