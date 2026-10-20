// Constants of the deep analysis queue that the browser needs too (the
// tender page refreshes while an analysis runs): no imports, so no server
// code comes along into the client bundle.

/** A request left running by a worker that died is taken up again after this long: longer than an analysis in six parts takes. */
export const DEEP_STALE_MINUTES = 60;
