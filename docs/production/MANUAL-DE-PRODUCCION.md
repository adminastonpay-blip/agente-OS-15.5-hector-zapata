# ASTON OS — Manual de producción y secuencia de etapas

**Estado:** política de planificación vigente  
**Decisión:** Cloudflare se reserva íntegramente para la etapa final.  
**Alcance:** desarrollo, revisión, pruebas y preparación de ASTON OS antes de producción.

## 1. Regla rectora

Todo trabajo que implique configurar, modificar, integrar, probar contra infraestructura real o desplegar componentes de **Cloudflare** queda pospuesto hasta la etapa final de ASTON OS.

Durante las etapas intermedias no se realizarán cambios operativos en la cuenta, los recursos ni los entornos de Cloudflare. Esta restricción incluye staging y producción. Se permite únicamente documentar dependencias, requisitos, riesgos y procedimientos futuros sin ejecutar cambios en la plataforma.

## 2. Trabajo permitido antes de la etapa final

Se puede continuar con trabajo local y revisión de código, manteniendo los cambios desacoplados de despliegues Cloudflare:

- Seguridad de aplicación: RBAC, autorización, Default Deny y SafetyInterlock.
- Identidad, autenticación y aislamiento multi-tenant.
- Ciclo de vida y gobernanza de tenants.
- Auditoría, trazabilidad, registros y controles de acceso.
- Backend, contratos de API y módulos internos.
- ASTON NOC y ASTON COMMAND, con sus límites de seguridad documentados.
- Pruebas unitarias, integración local, pruebas adversariales y análisis estático.
- Documentación técnica, operativa, de seguridad y comercial.
- Shopify y storefront, siempre sin usar Cloudflare como parte de esta etapa ni publicar cambios comerciales sin aprobación específica.

Toda prueba que requiera recursos, credenciales, bindings o servicios de Cloudflare deberá quedar marcada como pendiente de la etapa final. No se debe simular que una prueba local equivale a una validación de infraestructura real.

## 3. Actividades reservadas para la etapa final de Cloudflare

Cuando se autorice formalmente esa etapa, se abordarán en conjunto y con revisión previa:

- Cloudflare Workers: configuración, compatibilidad, variables y despliegue.
- D1: esquema, migraciones, integridad, backups y estrategia de recuperación.
- Queues y consumidores.
- Durable Objects y coordinación/estado.
- Vectorize y flujos de embeddings o recuperación.
- AI bindings y rutas de inferencia, cuando correspondan.
- Secrets, tokens, variables sensibles y rotación.
- Bindings por entorno y separación entre desarrollo, staging y producción.
- CORS, dominios, orígenes permitidos, headers y políticas de red.
- Observabilidad, alertas, health checks y respuesta a incidentes.
- Pruebas de integración reales, pruebas de seguridad y verificación de rollback.
- Despliegue controlado y validación posterior al despliegue.

La lista es una guía de alcance: solo se configurarán los servicios que la arquitectura final realmente necesite.

## 4. Condiciones de entrada a la etapa final

No iniciar la etapa Cloudflare hasta que:

1. Los controles críticos de autorización e identidad estén implementados y revisados.
2. Los límites multi-tenant y las pruebas negativas estén documentados y aprobados.
3. Los módulos y contratos de API estén estabilizados.
4. Las pruebas locales y de CI relevantes estén verdes, con evidencia reproducible.
5. Los hallazgos de seguridad críticos y altos estén resueltos o aceptados formalmente con mitigaciones.
6. Las migraciones, retención, backups y recuperación tengan diseño revisado.
7. Exista inventario de recursos, bindings, dominios y secretos requeridos, sin incluir valores secretos en Git.
8. Exista un plan de despliegue, rollback, monitoreo y respuesta a incidentes.
9. Se haya aprobado explícitamente el inicio de la etapa final y cada acción que afecte producción.

## 5. Controles de cambio y prohibiciones

Hasta la autorización de la etapa final:

- No crear, modificar ni eliminar Workers, D1, Queues, Durable Objects, Vectorize u otros recursos de Cloudflare.
- No ejecutar migraciones remotas ni cambiar bindings o configuraciones de entornos Cloudflare.
- No cargar, rotar, revelar ni modificar secrets o tokens de Cloudflare.
- No desplegar a staging ni producción en Cloudflare.
- No cambiar DNS, dominios, reglas de red, WAF, CORS ni políticas de acceso en Cloudflare.
- No considerar una configuración preparada o un archivo Wrangler como evidencia de despliegue o validación real.

La autorización general para continuar el desarrollo de ASTON OS no sustituye la aprobación específica para desplegar, modificar infraestructura o afectar producción.

## 6. Evidencia y estado

Cada tarea debe registrar su estado como uno de los siguientes:

- **Completada:** cambio realizado y evidencia verificable adjunta.
- **En revisión:** implementación disponible, pendiente de revisión o aprobación.
- **Pendiente — etapa final Cloudflare:** depende de recursos o validación real de Cloudflare.
- **Bloqueada:** requiere una decisión, credencial, dependencia o resolución previa.

No declarar producción lista, controles efectivos en Cloudflare, certificaciones ni cumplimiento normativo sin evidencia verificable.

## 7. Secuencia de ejecución

1. Completar y revisar seguridad, identidad y aislamiento multi-tenant.
2. Completar auditoría, trazabilidad, backend, NOC y COMMAND.
3. Ejecutar y documentar pruebas locales, CI y revisiones de código.
4. Resolver bloqueos y estabilizar arquitectura y contratos.
5. Revisar preparación operativa, documentación y requisitos legales aplicables.
6. Abrir formalmente la etapa final Cloudflare con alcance, responsables, aprobaciones y plan de rollback.
7. Ejecutar integración, pruebas y despliegue controlado solo tras autorización explícita.

## 8. Registro de decisión

La decisión de reservar **todo lo relacionado con Cloudflare para la etapa final** queda incorporada como regla de secuenciación del proyecto ASTON OS. Cualquier tarea que dependa de Cloudflare debe permanecer pendiente hasta que se abra esa etapa. Si una tarea intermedia parece requerir Cloudflare, se debe rediseñar para validación local o documentar como dependencia pendiente; no se debe eludir esta regla.

---

**Nota operativa:** este manual define el orden y los controles del trabajo. No constituye autorización de despliegue, evidencia de ejecución, auditoría independiente ni certificación de seguridad o cumplimiento.
