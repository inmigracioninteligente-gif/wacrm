import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { absolute: 'Política de Privacidad — AsiloCheck' },
  description:
    'Política de Privacidad de AsiloCheck: qué datos recolectamos, cómo los usamos y cómo se relacionan con WhatsApp Business API.',
  robots: { index: true, follow: true },
};

const LAST_UPDATED = '4 de julio de 2026';

const SECTIONS = [
  { id: 'introduccion', title: 'Introducción' },
  { id: 'datos-que-recolectamos', title: 'Qué datos recolectamos' },
  { id: 'como-usamos-los-datos', title: 'Cómo usamos los datos' },
  { id: 'whatsapp-business-api', title: 'Uso de WhatsApp Business API' },
  { id: 'compartir-con-terceros', title: 'Compartir información con terceros' },
  { id: 'seguridad-de-los-datos', title: 'Seguridad de los datos' },
  { id: 'derechos-del-usuario', title: 'Derechos del usuario' },
  { id: 'cambios-a-esta-politica', title: 'Cambios a esta política' },
  { id: 'contacto', title: 'Contacto' },
];

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
        <header className="mb-12">
          <p className="text-sm font-medium text-primary">AsiloCheck</p>
          <h1 className="mt-2 font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Política de Privacidad
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Última actualización: {LAST_UPDATED}
          </p>
        </header>

        <nav
          aria-label="Tabla de contenidos"
          className="mb-12 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
        >
          <p className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Contenido
          </p>
          <ol className="grid gap-1.5 sm:grid-cols-2">
            {SECTIONS.map((section, index) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="text-sm text-foreground/80 underline-offset-4 hover:text-primary hover:underline"
                >
                  {index + 1}. {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="space-y-10">
          <section id="introduccion" className="scroll-mt-8">
            <h2 className="font-heading text-xl font-semibold text-foreground">
              1. Introducción
            </h2>
            <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                En <strong className="text-foreground">AsiloCheck</strong> respetamos tu
                privacidad y nos comprometemos a proteger los datos personales que
                compartes con nosotros. Esta Política de Privacidad explica qué
                información recolectamos, cómo la usamos, con quién la compartimos y
                qué derechos tienes sobre ella.
              </p>
              <p>
                Al usar nuestros servicios, incluyendo cualquier interacción a través
                de WhatsApp, aceptas las prácticas descritas en este documento.
              </p>
            </div>
          </section>

          <section id="datos-que-recolectamos" className="scroll-mt-8">
            <h2 className="font-heading text-xl font-semibold text-foreground">
              2. Qué datos recolectamos
            </h2>
            <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>Podemos recolectar los siguientes tipos de datos:</p>
              <ul className="list-disc space-y-1.5 pl-5">
                <li>
                  Datos de contacto: nombre, número de teléfono y, cuando aplique,
                  dirección de correo electrónico.
                </li>
                <li>
                  Contenido de las conversaciones que mantienes con nosotros a través
                  de WhatsApp u otros canales de mensajería.
                </li>
                <li>
                  Información que nos proporcionas voluntariamente sobre tu caso o
                  consulta.
                </li>
                <li>
                  Datos técnicos básicos (como marcas de tiempo o metadatos del
                  mensaje) generados durante el uso del servicio.
                </li>
              </ul>
            </div>
          </section>

          <section id="como-usamos-los-datos" className="scroll-mt-8">
            <h2 className="font-heading text-xl font-semibold text-foreground">
              3. Cómo usamos los datos
            </h2>
            <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>Utilizamos los datos que recolectamos para:</p>
              <ul className="list-disc space-y-1.5 pl-5">
                <li>Responder a tus consultas y brindarte la información solicitada.</li>
                <li>Dar seguimiento a tu caso o solicitud a través del tiempo.</li>
                <li>Mejorar la calidad de nuestros servicios y atención al usuario.</li>
                <li>Cumplir con obligaciones legales aplicables.</li>
              </ul>
              <p>No usamos tus datos para fines distintos a los descritos aquí.</p>
            </div>
          </section>

          <section id="whatsapp-business-api" className="scroll-mt-8">
            <h2 className="font-heading text-xl font-semibold text-foreground">
              4. Uso de WhatsApp Business API
            </h2>
            <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                AsiloCheck utiliza la WhatsApp Business API, provista por Meta
                Platforms, Inc., para comunicarse contigo. Cuando nos escribes por
                WhatsApp o interactúas con nuestra cuenta oficial de WhatsApp
                Business, tus mensajes y datos asociados son procesados a través de
                esta plataforma conforme a la{' '}
                <a
                  href="https://www.whatsapp.com/legal/business-data-processing-terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-4 hover:text-primary/80"
                >
                  Política de Privacidad de WhatsApp
                </a>{' '}
                y sus términos para uso empresarial.
              </p>
              <p>
                Usamos esta integración únicamente para gestionar la comunicación
                contigo y ofrecerte soporte relacionado con tu consulta o caso. No
                utilizamos WhatsApp Business API para enviar mensajes no solicitados
                ni para fines de marketing sin tu consentimiento.
              </p>
            </div>
          </section>

          <section id="compartir-con-terceros" className="scroll-mt-8">
            <h2 className="font-heading text-xl font-semibold text-foreground">
              5. Compartir información con terceros
            </h2>
            <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                No vendemos ni alquilamos tus datos personales. Podemos compartir
                información limitada con:
              </p>
              <ul className="list-disc space-y-1.5 pl-5">
                <li>
                  Proveedores de servicios que nos ayudan a operar la plataforma
                  (por ejemplo, hosting, infraestructura de mensajería o soporte
                  técnico), sujetos a obligaciones de confidencialidad.
                </li>
                <li>
                  Meta Platforms, Inc., en la medida necesaria para el
                  funcionamiento de WhatsApp Business API.
                </li>
                <li>
                  Autoridades competentes, cuando sea requerido por ley o para
                  proteger nuestros derechos legales.
                </li>
              </ul>
            </div>
          </section>

          <section id="seguridad-de-los-datos" className="scroll-mt-8">
            <h2 className="font-heading text-xl font-semibold text-foreground">
              6. Seguridad de los datos
            </h2>
            <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                Implementamos medidas técnicas y organizativas razonables para
                proteger tu información contra accesos no autorizados, pérdida,
                alteración o divulgación indebida. Sin embargo, ningún sistema es
                completamente seguro, por lo que no podemos garantizar la seguridad
                absoluta de los datos transmitidos.
              </p>
            </div>
          </section>

          <section id="derechos-del-usuario" className="scroll-mt-8">
            <h2 className="font-heading text-xl font-semibold text-foreground">
              7. Derechos del usuario
            </h2>
            <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>Tienes derecho a:</p>
              <ul className="list-disc space-y-1.5 pl-5">
                <li>Acceder a los datos personales que tenemos sobre ti.</li>
                <li>Solicitar la corrección de datos inexactos o incompletos.</li>
                <li>Solicitar la eliminación de tus datos, cuando sea aplicable.</li>
                <li>
                  Oponerte u objetar al procesamiento de tus datos en determinadas
                  circunstancias.
                </li>
              </ul>
              <p>
                Para ejercer cualquiera de estos derechos, contáctanos usando la
                información que aparece en la sección{' '}
                <a
                  href="#contacto"
                  className="text-primary underline underline-offset-4 hover:text-primary/80"
                >
                  Contacto
                </a>
                .
              </p>
            </div>
          </section>

          <section id="cambios-a-esta-politica" className="scroll-mt-8">
            <h2 className="font-heading text-xl font-semibold text-foreground">
              8. Cambios a esta política
            </h2>
            <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                Podemos actualizar esta Política de Privacidad ocasionalmente para
                reflejar cambios en nuestras prácticas o por razones legales u
                operativas. Publicaremos cualquier cambio en esta misma página junto
                con la fecha de la última actualización.
              </p>
            </div>
          </section>

          <section id="contacto" className="scroll-mt-8">
            <h2 className="font-heading text-xl font-semibold text-foreground">
              9. Contacto
            </h2>
            <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                Si tienes preguntas o inquietudes sobre esta Política de Privacidad
                o sobre cómo tratamos tus datos, puedes contactarnos en:
              </p>
              <div className="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
                <p className="text-sm font-medium text-foreground">AsiloCheck</p>
                <a
                  href="mailto:info@asilocheck.com"
                  className="mt-1 inline-block text-sm text-primary underline underline-offset-4 hover:text-primary/80"
                >
                  info@asilocheck.com
                </a>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
