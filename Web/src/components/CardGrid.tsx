import type { CardGroup } from "../lib/view";
import { CardBlock } from "./CardBlock";

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
