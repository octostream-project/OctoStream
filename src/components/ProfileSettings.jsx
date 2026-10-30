import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { Users, Plus, Shield, Trash2, UserRound } from 'lucide-react'

export default function ProfileSettings() {
  const profiles = useStore(s => s.profiles)
  const activeProfileId = useStore(s => s.activeProfileId)
  const createProfile = useStore(s => s.createProfile)
  const switchProfile = useStore(s => s.switchProfile)
  const deleteProfile = useStore(s => s.deleteProfile)
  const [name, setName] = useState('')
  const [kids, setKids] = useState(false)
  const [pin, setPin] = useState('')
  const [targetId, setTargetId] = useState('')
  const [switchPin, setSwitchPin] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const active = profiles.find(p => p.id === activeProfileId)
  const target = profiles.find(p => p.id === targetId)

  const handleCreate = async (e) => {
    e.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      await createProfile(name, { kids, pin })
      setName('')
      setPin('')
      setKids(false)
      setNotice('Perfil creado. Sus favoritos e historial empiezan separados.')
    } catch (err) {
      setError(err.message || 'No se pudo crear el perfil.')
    } finally {
      setBusy(false)
    }
  }

  const handleSwitch = async () => {
    if (!targetId) return
    setError('')
    setBusy(true)
    try {
      await switchProfile(targetId, switchPin)
      setTargetId('')
      setSwitchPin('')
      setNotice('Perfil cambiado.')
    } catch (err) {
      setError(err.message || 'No se pudo cambiar el perfil.')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = (profile) => {
    if (!window.confirm(`¿Borrar el perfil "${profile.name}" y sus favoritos, historial y progreso de este dispositivo?`)) return
    try {
      deleteProfile(profile.id)
      setNotice('Perfil y datos locales borrados.')
      setError('')
    } catch (err) { setError(err.message || 'No se pudo borrar el perfil.') }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-dark-700 bg-dark-800/50 p-5">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-600/20">
            <Users size={20} className="text-primary-300" />
          </div>
          <div>
            <h2 className="font-bold text-white">Perfiles de casa</h2>
            <p className="text-sm text-dark-400">Cada perfil tiene Mi Lista, historial y progreso independientes.</p>
          </div>
        </div>
        <p className="mb-3 rounded-lg bg-dark-900/70 px-3 py-2 text-xs text-dark-400">
          Los perfiles se guardan en este dispositivo. Para evitar mezclar bibliotecas, sincronización LAN solo combina datos cuando coincide el perfil; el registro de perfiles no se exporta en copias de configuración.
        </p>
        <div className="space-y-2">
          {profiles.map(profile => (
            <div key={profile.id} className={`flex flex-wrap items-center gap-3 rounded-xl border p-3 ${profile.id === activeProfileId ? 'border-primary-500/60 bg-primary-900/10' : 'border-dark-700 bg-dark-900/60'}`}>
              <UserRound size={18} className={profile.id === activeProfileId ? 'text-primary-300' : 'text-dark-500'} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-white">{profile.name}{profile.id === activeProfileId ? ' · activo' : ''}</p>
                <p className="text-xs text-dark-400">{profile.kids ? 'Infantil · títulos marcados para adultos ocultos' : 'Perfil general'}</p>
              </div>
              {profile.id !== activeProfileId && (
                <>
                  <button type="button" onClick={() => { setTargetId(profile.id); setError(''); setSwitchPin('') }} className="rounded-lg bg-dark-700 px-3 py-2 text-xs text-white hover:bg-dark-600">Cambiar</button>
                  {profile.id !== 'default' && (
                    <button type="button" onClick={() => handleDelete(profile)} aria-label={`Borrar ${profile.name}`} className="rounded-lg p-2 text-dark-500 hover:bg-red-950/40 hover:text-red-300"><Trash2 size={16} /></button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
        {target && (
          <div className="mt-3 rounded-xl border border-primary-500/30 bg-dark-900 p-3">
            <p className="mb-2 text-sm text-white">Cambiar a <strong>{target.name}</strong></p>
            {active?.kids && active.pinHash && (
              <input
                type="password"
                inputMode="numeric"
                maxLength={8}
                value={switchPin}
                onChange={e => setSwitchPin(e.target.value.replace(/\D/g, ''))}
                placeholder="PIN del perfil infantil"
                className="mb-2 w-full rounded-lg border border-dark-700 bg-dark-800 px-3 py-2 text-white"
              />
            )}
            <div className="flex gap-2">
              <button type="button" onClick={() => setTargetId('')} className="rounded-lg bg-dark-700 px-3 py-2 text-sm text-dark-200">Cancelar</button>
              <button type="button" disabled={busy} onClick={handleSwitch} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Confirmar cambio</button>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-dark-700 bg-dark-800/50 p-5">
        <h3 className="mb-1 font-bold text-white">Añadir perfil</h3>
        <p className="mb-4 text-sm text-dark-400">Los perfiles nuevos no modifican ni copian los datos existentes.</p>
        <form onSubmit={handleCreate} className="space-y-3">
          <input value={name} onChange={e => setName(e.target.value)} maxLength={24} required placeholder="Nombre (por ejemplo, Alex)" className="w-full rounded-xl border border-dark-700 bg-dark-900 px-3 py-2.5 text-white placeholder:text-dark-500 focus:border-primary-500 focus:outline-none" />
          <label className="flex items-start gap-3 rounded-xl bg-dark-900/70 p-3">
            <input type="checkbox" checked={kids} onChange={e => setKids(e.target.checked)} className="mt-1 accent-primary-500" />
            <span>
              <span className="flex items-center gap-2 text-sm font-medium text-white"><Shield size={15} className="text-emerald-300" /> Perfil infantil</span>
              <span className="mt-1 block text-xs text-dark-400">Oculta contenido que el proveedor marca como adulto. No es un control parental a prueba de evasión: los metadatos pueden estar incompletos.</span>
            </span>
          </label>
          {kids && <input type="password" inputMode="numeric" maxLength={8} minLength={4} required value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} placeholder="PIN adulto (4–8 dígitos)" className="w-full rounded-xl border border-dark-700 bg-dark-900 px-3 py-2.5 text-white placeholder:text-dark-500 focus:border-primary-500 focus:outline-none" />}
          <button disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-primary-600 px-4 py-2.5 font-medium text-white hover:bg-primary-500 disabled:opacity-50"><Plus size={17} /> Crear perfil</button>
        </form>
      </section>

      {(error || notice) && <p role="status" className={`rounded-xl px-4 py-3 text-sm ${error ? 'bg-red-950/40 text-red-200' : 'bg-emerald-950/30 text-emerald-200'}`}>{error || notice}</p>}
    </div>
  )
}
