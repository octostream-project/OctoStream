// EstrenosCinesaA — películas y series en castellano (DooPlay).
// Sugerida por Balandro; dominio actual: estrenoscinesaa.com
import { makeDooplayChannel } from './dooplay.js'

export const estrenoscinesaa = makeDooplayChannel({
  id: 'estrenoscinesaa',
  name: 'EstrenosCinesaA',
  host: 'https://www.estrenoscinesaa.com/',
  defaultLang: 'ESP',
})
