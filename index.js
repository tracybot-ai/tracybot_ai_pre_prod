const { google } = require('googleapis');
const { WebhookClient } = require('dialogflow-fulfillment');
const { JWT } = require('google-auth-library');
const { DateTime } = require('luxon');
const { BigQuery } = require('@google-cloud/bigquery'); // BigQuery SDK

// Service account credentials
const SERVICE_ACCOUNT_FILE_CALENDAR = 'tracybot-ai-mvp-eefca2fcc4f2.json';
const SERVICE_ACCOUNT_FILE_BIGQUERY = 'tracybot-ai-mvp-0ad77468a843-to-bigquery.json';

// Configuración de autenticación para Google Calendar
const auth = new JWT({
  keyFile: SERVICE_ACCOUNT_FILE_CALENDAR,
  scopes: ['https://www.googleapis.com/auth/calendar'],
});

const calendar = google.calendar({ version: 'v3', auth });

// Configuración de BigQuery
const bigquery = new BigQuery({
  keyFilename: SERVICE_ACCOUNT_FILE_BIGQUERY,
  projectId: 'tracybot-ai-mvp', // Reemplaza con tu ID de proyecto
});

const datasetId = 'dialogflow_dataset'; // Reemplaza con tu dataset de BigQuery
const tableId = 'intent_logs'; // Reemplaza con tu tabla de BigQuery

// Función para insertar los datos en BigQuery
async function insertIntoBigQuery(intentData) {
  try {
    await bigquery
      .dataset(datasetId)
      .table(tableId)
      .insert([intentData]);
    console.log('Datos insertados en BigQuery exitosamente');
  } catch (error) {
    console.error('Error insertando los datos en BigQuery:', error);
  }
}

// Función para manejar el intent "Dejarmensaje"
function handleLeaveMessage(agent) {
  const person = agent.parameters.person.name;
  const email = agent.parameters.email;
  const message = agent.parameters.message;

  const today = DateTime.now().setZone('America/Lima').toISODate();
  const currentTime = DateTime.now().setZone('America/Lima').setLocale('es').toLocaleString({
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });

  const calendarId = 'c_42a99d86c349612b7839125729a4405519cd0cbc1d3b30dcb2747ad2262ed429@group.calendar.google.com';

  const messageWithTimestamp = `Mensaje de ${person}, ${email} enviado el ${currentTime}: ${message}`;

  return calendar.events.list({
    calendarId: calendarId,
    timeMin: DateTime.now().startOf('day').toISO(),
    timeMax: DateTime.now().endOf('day').toISO(),
    singleEvents: true,
    q: 'Mensajes Recibidos',
  }).then(response => {
    const events = response.data.items;

    if (events.length > 0) {
      const eventId = events[0].id;
      const updatedDescription = events[0].description + `\n\n${messageWithTimestamp}`;

      return calendar.events.patch({
        calendarId: calendarId,
        eventId: eventId,
        resource: {
          description: updatedDescription
        }
      }).then((updateResponse) => {
        agent.add(`Gracias, ${person}. Tu mensaje ha sido enviado al supervisor. Te contactaremos a través de ${email}.`);

        // Insertar los datos en BigQuery de forma asíncrona
        const intentData = {
          intent: 'Dejarmensaje',
          person: person,
          email: email,
          message: message,
          timestamp: new Date().toISOString(), // Asegurar formato ISO
        };
        insertIntoBigQuery(intentData);

        return Promise.resolve();
      }).catch(error => {
        console.error('Error actualizando el evento:', error);
        agent.add('Hubo un error al actualizar el evento en Google Calendar.');
        return Promise.reject();
      });
    } else {
      const event = {
        summary: 'Mensajes Recibidos',
        description: messageWithTimestamp,
        start: {
          date: today,
        },
        end: {
          date: today,
        },
      };

      return calendar.events.insert({
        calendarId: calendarId,
        resource: event
      }).then((insertResponse) => {
        agent.add(`Gracias, ${person}. Tu mensaje ha sido enviado al supervisor. Te contactaremos a través de ${email}.`);

        // Insertar los datos en BigQuery de forma asíncrona
        const intentData = {
          intent: 'Dejarmensaje',
          person: person,
          email: email,
          message: message,
          timestamp: new Date().toISOString(), // Asegurar formato ISO
        };
        insertIntoBigQuery(intentData);

        return Promise.resolve();
      }).catch(error => {
        console.error('Error creando el evento:', error);
        agent.add('Hubo un error al crear el evento en Google Calendar.');
        return Promise.reject();
      });
    }
  }).catch(error => {
    console.error('Error buscando eventos en Google Calendar:', error);
    agent.add('Hubo un error al buscar eventos en Google Calendar.');
    return Promise.reject();
  });
}

// Función para manejar el intent "CrearCita"
function createCalendarEvent(agent) {
  try {
    const calendarId = 'c_42a99d86c349612b7839125729a4405519cd0cbc1d3b30dcb2747ad2262ed429@group.calendar.google.com';
    const person = agent.parameters.person.name;
    const date = agent.parameters.date;
    const eventNumber = agent.parameters.number;
    const phoneNumber = agent.parameters['phone-number'];

    console.log(`DEBUG - Person: ${person}, Date: ${date}, Number: ${eventNumber}, Phone: ${phoneNumber}`);

    let hour24, timePeriod;
    try {
      const { hour24: adjustedHour, timePeriod: tp } = interpretAndValidateHour(eventNumber);
      hour24 = adjustedHour;
      timePeriod = tp;
      console.log(`DEBUG - Hora ajustada: ${hour24}, Periodo: ${timePeriod}`);
    } catch (error) {
      agent.add(error.message);
      return Promise.resolve();
    }

    if (!isWeekday(date)) {
      agent.add('Lo siento, las citas sólo se pueden agendar de lunes a viernes.');
      return Promise.resolve();
    }

    const eventDateTime = DateTime.fromISO(date, { zone: 'America/Lima' }).set({ hour: hour24, minute: 0 });
    const endDateTime = eventDateTime.plus({ hours: 1 });

    console.log(`DEBUG - Fecha y hora del evento: ${eventDateTime.toISO()}`);

    return calendar.events.list({
      calendarId: calendarId,
      timeMin: eventDateTime.toISO(),
      timeMax: endDateTime.toISO(),
      timeZone: 'America/Lima',
      singleEvents: true
    }).then(response => {
      const events = response.data.items;

      if (events.length > 0) {
        agent.add(`Lo siento, ya existe una cita en ese horario. Por favor elige otro horario.`);
        return Promise.resolve();
      }

      const event = {
        summary: `Cita con ${person} - Teléfono: ${phoneNumber}`,
        description: `Cita con ${person}. Teléfono: ${phoneNumber}`,
        start: {
          dateTime: eventDateTime.toISO(),
          timeZone: 'America/Lima'
        },
        end: {
          dateTime: endDateTime.toISO(),
          timeZone: 'America/Lima'
        },
      };

      return calendar.events.insert({ calendarId, resource: event })
        .then((insertResponse) => {
          console.log('DEBUG - Evento creado exitosamente:', insertResponse.data);

          // Formatear la fecha y hora
          let formattedDate = eventDateTime.setLocale('es').toLocaleString({ weekday: 'long', day: 'numeric', month: 'long' });
          formattedDate = formattedDate.charAt(0).toUpperCase() + formattedDate.slice(1);

          // Convertir la hora a formato 12 horas (con AM/PM)
          const hour12Format = eventDateTime.toFormat('h:mm a');

          agent.add(`${person}, tu cita ha sido creada con éxito! Para el ${formattedDate} a las ${hour12Format}. Número de teléfono para gestión de cita: ${phoneNumber}. ¡Te esperamos!`);

          // Ajustar la fecha y hora para BigQuery
          const formattedISODate = DateTime.fromISO(date).toISODate(); // Solo la parte de la fecha
          const formattedTime = eventDateTime.toFormat('HH:mm:ss'); // Extraer la hora en formato TIME (HH:mm:ss)

          // Insertar los datos en BigQuery de forma asíncrona
          const intentData = {
            intent: 'CrearCita',
            person: person,
            date: formattedISODate,
            time: formattedTime,
            phoneNumber: phoneNumber,
            timestamp: new Date().toISOString(),
          };

          console.log('DEBUG - IntentData para BigQuery:', intentData);
          insertIntoBigQuery(intentData); // Inserción asíncrona en BigQuery

          return Promise.resolve();
        }).catch((error) => {
          console.error('Error creando el evento:', error);
          agent.add('Hubo un error al crear el evento.');
          return Promise.reject();
        });
    }).catch(error => {
      console.error('Error verificando conflictos:', error);
      agent.add('Hubo un error al verificar los horarios disponibles.');
      return Promise.reject();
    });
  } catch (err) {
    console.error('Error en el procesamiento:', err);
    agent.add('Lo siento, hubo un error procesando tu solicitud.');
    return Promise.reject();
  }
}

// Función para interpretar la hora en formato de 24 horas y validar el horario comercial
function interpretAndValidateHour(number) {
  let hour24;
  let timePeriod;

  if (number >= 9 && number <= 12) {
    hour24 = number;
    timePeriod = number === 12 ? 'PM' : 'AM';
  } else if (number >= 1 && number <= 5) {
    hour24 = number + 12;
    timePeriod = 'PM';
  } else {
    throw new Error('La hora ingresada está fuera del horario permitido. Solo se permiten citas entre 9 AM - 12 PM y 3 PM - 5 PM.');
  }

  if ((hour24 >= 9 && hour24 <= 12) || (hour24 >= 15 && hour24 <= 17)) {
    return { hour24, timePeriod };
  } else {
    throw new Error('La hora ingresada está fuera del horario de atención. Solo se permiten citas entre 9 AM - 12 PM y 3 PM - 5 PM.');
  }
}

// Función para verificar si la fecha es un día laborable (lunes a viernes)
function isWeekday(dateString) {
  const date = new Date(dateString);
  const dayOfWeek = date.getDay();
  return dayOfWeek >= 1 && dayOfWeek <= 5;
}

// Mapeamos los intents de Dialogflow a sus manejadores de funciones
exports.dialogflowwebhook3 = (req, res) => {
  const agent = new WebhookClient({ request: req, response: res });

  let intentMap = new Map();
  intentMap.set('CrearCita', createCalendarEvent);
  intentMap.set('Dejarmensaje', handleLeaveMessage);

  agent.handleRequest(intentMap);
};
