// CineMitas — películas y series, castellano/latino/VOSE (DooPlay).
// Sugerida por Balandro; dominio actual: cinemitas.org
import { makeDooplayChannel } from './dooplay.js'

export const cinemitas = makeDooplayChannel({
  id: 'cinemitas',
  name: 'CineMitas',
  host: 'https://cinemitas.org/',
  defaultLang: 'ESP',
})
