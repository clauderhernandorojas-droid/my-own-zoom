/**
 * Presenter de modelos `Reunion`: convierte instancias Sequelize (o POJOs)
 * al JSON que consume el cliente, enriqueciéndolo con metadatos derivados
 * (banderas de reagendamiento y campos legibles por ocurrencia).
 *
 * Vive como módulo aparte para que servicios y rutas compartan la misma
 * serialización sin duplicar la lógica.
 */

function reunionJsonWithReagenda(reunion) {
  if (!reunion) return null;
  const j = typeof reunion.toJSON === 'function' ? reunion.toJSON() : { ...reunion };
  const ex = Array.isArray(j.ocurrenciaExcepciones) ? j.ocurrenciaExcepciones : [];
  j.reagendada = ex.length > 0;
  j.ocurrenciaExcepciones = ex.map((row) => {
    const o = { ...row };
    o.reagendada = true;
    o.fechaOriginal = o.fechaOcurrenciaOriginal ?? o.fecha_ocurrencia_original;
    o.nuevaFecha = o.fechaOcurrenciaOverride ?? o.fecha_ocurrencia_override;
    o.occurrenceId = o.reunionOcurrenciaId ?? o.reunion_ocurrencia_id ?? null;
    return o;
  });
  return j;
}

module.exports = { reunionJsonWithReagenda };
