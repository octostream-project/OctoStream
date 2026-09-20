// Ligas del calendario de fútbol: definición compartida entre Sports.jsx
// (vista) y utils/loadPlan.js (precarga en background). Antes vivían inline
// en Sports.jsx, que es un chunk lazy — importarlo desde el plan de carga
// lo metería en el bundle principal.

import { MARCA_LEAGUES } from './marcaCalendar.js'
import { tournamentImg } from '../utils/sofascore.js'

// Nombre comercial en Marca → nombre del torneo en Sofascore.
export const MARCA_TO_SOFA = {
  'LaLiga EA Sports': 'LaLiga',
  'LaLiga Hypermotion': 'LaLiga 2',
  'Champions League': 'UEFA Champions League',
  'Europa League': 'UEFA Europa League',
}

// Competiciones españolas sin página de calendario en Marca: su tarjeta se
// alimenta solo de Sofascore en runtime. El utId fijo evita la búsqueda por
// nombre, ambigua (hay una "Copa del Rey" por deporte). Sin datos (offline u
// off-season) la tarjeta no se muestra. Tercera RFEF no tiene torneo único
// en Sofascore (son 18 grupos separados): solo aparece con directos.
export const EXTRA_SOFA_LEAGUES = [
  { slug: 'primera-rfef', name: 'Primera Federación', utId: 17073 },
  { slug: 'segunda-rfef', name: 'Segunda Federación', utId: 544 },
  { slug: 'liga-f', name: 'Liga F', utId: 1127 },
  { slug: 'copa-del-rey', name: 'Copa del Rey', utId: 329 },
  { slug: 'supercopa', name: 'Supercopa de España', utId: 213 },
].map(l => ({ ...l, jornadas: [], logo: tournamentImg(l.utId) }))

export const CAL_LEAGUES = [...MARCA_LEAGUES, ...EXTRA_SOFA_LEAGUES]
