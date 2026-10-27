/** Globals shared between the separately bundled scripts of the fixture site. */
interface PinewoodShield {
  /** Settles once `/shield/collect` has answered and the `_abck` cookie is set. */
  ready: Promise<void>
}

interface Window {
  pmShield?: PinewoodShield
}
