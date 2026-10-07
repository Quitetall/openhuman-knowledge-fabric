/**
 * THE NEEDS-YOU SLOT. KF-WAR-0004 (milestone M2) supplies this panel's component and its data:
 * what an agent submitted and is waiting on a person, and the one-click verify. The dashboard
 * (KF-WAR-0005, M3) owns only its PLACE — third in the one layout, after the overview and the
 * master document — and renders whatever this returns there, inside its own separated section.
 *
 * Until M2 lands it returns nothing, and the slot collapses like any empty panel. M2 replaces the
 * body of this function (or re-exports its own component as `NeedsYouSlot`); nothing else in the
 * dashboard needs to change, and nothing here may branch on who the reader is.
 */
export function NeedsYouSlot(): React.ReactNode {
  return null;
}
