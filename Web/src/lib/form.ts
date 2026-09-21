// What a form on a detail page is doing, and what its panel shows.
//
// A form is the one thing a view writes, and it is a panel a button opened, so
// what becomes of that panel is part of the rule rather than an afterthought.
// A write shuts it: the row it belonged to may still be on the page, and a
// panel left open would hold the values the write was made from and a button
// that can never be pressed again. A failure leaves it exactly as it was, with
// what the server said underneath, so what was typed can be put right and
// saved again.

export interface FormPanel {
  /** Whether the panel is still on the page. */
  open: boolean;
  /** Whether a save is in flight, which is what the one button is disabled
   *  by. */
  saving: boolean;
  /** What the server said went wrong, shown under the fields. */
  failure: string | null;
}

/** A panel waiting to be filled in, which is what one that has just been
 *  opened shows and what a refused one goes back to when it is tried again. */
export const TYPING: FormPanel = { open: true, saving: false, failure: null };

/** A save is on its way. */
export const SAVING: FormPanel = { open: true, saving: true, failure: null };

/** A write landed. The panel goes, so a row that is still on the page is
 *  usable again and a second write starts from what the page now says rather
 *  than from what the first one was typed into. */
export const WRITTEN: FormPanel = { open: false, saving: false, failure: null };

/** A save was refused. The panel stays exactly as it was, with the reason
 *  under it. */
export function refused(message: string): FormPanel {
  return { open: true, saving: false, failure: message };
}
