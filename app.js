// app.js

const {
  exec
} = require('child_process')
const puppeteer = require('puppeteer')
const wait = require('waait')
const nodemailer = require('nodemailer')
const fs = require('fs')
const express = require('express')
const bodyParser = require('body-parser')
const _ = require('lodash')

const {
  check,
  validationResult,
  matchedData
} = require('express-validator')

const validator = require('validator')

const AWS = require('aws-sdk')

// Reads a .env file
require('dotenv').config()

const app = express()

AWS.config.update({
  region: 'us-east-1'
})
let ddb = new AWS.DynamoDB.DocumentClient()

// Time between each check in ms (5 minutes)
const msBetweenChecks = 300000

// Webadvisor course variables
const courseSemester = 'F20'

// max 5 courses	
const courses = ['CIS*3260', 'UNIV*2100', 'CIS*1250', 'NUTR*1010']

// Headless?
const headless = true

const PORT = 3000

const UNIX_DAY = 86400

app.use(bodyParser.urlencoded({
  extended: false
}))

/********************************
 **** ROUTER CODE IS BROKEN *****
 *** UNTIL IT WRITES TO DYNAMO **
/********************************/
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/templates/inputForm.html')
})

app.post('/subscribe', [
  // validates the courses array has a non-empty field and returns an escaped and trimmed version of each value
  check('courses').isArray().custom(courses => {
    return courses.some(c => c)
  }).withMessage('At least one course must be selected').bail().customSanitizer(courses => {
    return courses.map(c => _.trim(_.escape(c)))
  }),

  // validates and normalizes the email from the client
  // For details on the email normalization see the normalizeEmail at https://github.com/validatorjs/validator.js#sanitizers
  check('email').isEmail().withMessage('Invalid Email').bail().trim().normalizeEmail(),
], (req, res) => {
  const formErrors = validationResult(req)

  if (!formErrors.isEmpty()) {
    console.error('formErrors', formErrors)
    return res.status(400).send(`formErrors -- ${JSON.stringify(formErrors)}`)
  }

  // Ensures the app only uses data that has been validated
  const validatedData = matchedData(req)

  // start an instance of the service
  updateCourseInfo(validatedData.courses, validatedData.email)
  return res.send('started a new process')
})

// Runs the application with the constants defined above
// TODO: Update to use all webadvisor data
updateCourseInfo(courses)

app.listen(PORT)

async function updateCourseInfo(courses) {
  while (true) {
    try {
      const availableCourseInfo = await checkWebadvisor(courses)
      
      const courseKeys = Object.keys(availableCourseInfo)
      const courseCodeEmailMap = await getEmailsCourseCodesFromDyanmo(courseKeys)

      sendEmail(availableCourseInfo, courseCodeEmailMap)
      await wait(msBetweenChecks)
    } catch (error) {
      console.log(error)
    }
  }
}

async function checkWebadvisor(courses) {
  const browser = await puppeteer.launch({ headless })

  const page = await browser.newPage()

  page.on('console', (msg) => console.log('PAGE LOG:', msg.text()))

  await page.goto('https://webadvisor.uoguelph.ca')
  await page.waitForNavigation({
    waitUntil: 'networkidle0'
  })

  await Promise.all([
    page.click('#sidebar > div > div.subnav > ul > li:nth-child(2) > a'),
    page.waitForNavigation({
      waitUntil: 'networkidle0'
    }),
  ])

  await Promise.all([
    page.click('#sidebar > div > ul:nth-child(2) > li > a'),
    page.waitForNavigation({
      waitUntil: 'networkidle0'
    }),
  ])

  // Fill out Search for Sections
  await Promise.all([
    page.select('#VAR1', courseSemester),
    [0, 1, 2, 3, 4, 5, 6]
    .map((num) => {
      return page.click(`#VAR${num+10}`)
    })
  ])

  await Promise.all([
    page.click('#content > div.screen.WESTS12A > form > div > input'),
    page.waitForNavigation({
      waitUntil: 'networkidle0',
      timeout: 0
    }),
  ])

  // await wait(msBetweenChecks)
  // Determine if offering is open - evaluated in browser
  const availableCourseInfo = await page.evaluate(() => {
    const offerings = document.querySelectorAll('#GROUP_Grp_WSS_COURSE_SECTIONS > table > tbody > tr')

    // generate base course map Ex. { 'CIS*1234': [] } cant use ES6 :(
    const courseMap = {}

    offerings.forEach((row, index) => {
      // First two rows are just headings
      if (index < 2) return

      const splitCourseRow = row.innerText
        .split('\n\n')
        .map((s) => s.trim())
        .filter((s) => s.length)

      // Parses out the course code in the format XXX*1111
      // Note: There should only be one course code
      const courseCode = splitCourseRow[2].match(/[A-Za-z]+\*[0-9]+/)[0]

      if (!courseMap[courseCode]) {
        courseMap[courseCode] = []
      }

      courseMap[courseCode].push(splitCourseRow)
    })

    return courseMap
  })

  // log time
  console.log(`\nTIME: ${new Date().toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true })}`)

  console.log('\x1b[37m', '\nAYO, THREAD CHECK\n')
  await browser.close()

  let openCourses = {}
  Object.entries(availableCourseInfo).forEach(([key, val]) => {
    if (!val.length) {
      return
    }

    openCourses[key] = val
  })

  return openCourses
}

/**
 * Emails all the users that have susbscribed to course information
 * and havent been notified since the beginning of the day
 * 
 * @param {Object} courseMap - Parsed course data from webadvisor
 * @param {Object} courseCodeEmailMap - Keys correspond to the course codes and the value 
 * is an array of emails to send the course to
 */
async function sendEmail(courseMap, courseCodeEmailMap) {
  const EMAIL_SERVICE = process.env.EMAIL_SERVICE
  const EMAIL_ADDR = process.env.EMAIL_ADDR
  const EMAIL_PWD = process.env.EMAIL_PWD

  if (!EMAIL_SERVICE || !EMAIL_ADDR || !EMAIL_PWD) {
    console.warn('Email sending is not enabled. To enable email sending please set the EMAIL_SERVICE, EMAIL_ADDR and EMAIL_PWD env variables')
    return
  }

  const transporter = nodemailer.createTransport({
    service: EMAIL_SERVICE,
    auth: {
      user: EMAIL_ADDR,
      pass: EMAIL_PWD
    }
  })

  await Promise.all(Object.entries(courseCodeEmailMap).map(async ([courseCode, emails], i) => {
    if (!emails || emails.length == 0 || !courseMap[courseCode] || courseMap[courseCode].length == 0) {
      console.info(`no emails to send in batch ${i + 1} -- courses: ${courseMap[courseCode]} -- emails: ${emails}`)
      return
    }

    const courseDetailsHTML = formatCourseInfoHTML(courseCode, courseMap[courseCode])

    const response = await transporter.sendMail({
      from: EMAIL_ADDR,
      to: EMAIL_ADDR,
      bcc: emails,
      subject: `Your course selection info for ${courseCode}`,
      html: fs.readFileSync(__dirname + '/templates/coursesAvailableEmail.html', 'utf8').replace('${INSERT_INFO_HERE}', courseDetailsHTML),
    })

    // Filters out our email address from the response
    response.accepted = response.accepted.filter(email => email != EMAIL_ADDR)
    response.rejected = response.rejected.filter(email => email != EMAIL_ADDR)

    console.warn(`batch ${i + 1} - failed emails`, response.rejected)
    console.info(`batch ${i + 1} - successful emails`, response.accepted)

    response.accepted.forEach((email) => {  
      updateDynamoData(courseCode, email)        
    })
  }))
}

function formatCourseInfoHTML(courseCode, courseInfo) {
  if (!courseInfo.length) {
    return ''
  }

  return `<p><b>${courseCode}</b> has sections available</p> <p>${courseInfo}</p> <br>`
}

/**
 * Queries dynamo db to find the user's to notify for each course
 * 
 * @param {Array} courseCodes - Array of course codes of available courses
 * @returns {Object} - Keys correspond to the course codes and the value 
 * is an array of emails to send the course to
 */
async function getEmailsCourseCodesFromDyanmo(courseCodes) {
  const CURRENT_DATE_UNIX = new Date().setHours(0, 0, 0, 0)

  let dynamoData = await getDataFromDynamo(courseCodes)

  if (!dynamoData) {
    console.warn('No data from DynamoDB')
    return {}
  }

  let courseCodeEmailMap = {}
  dynamoData.forEach((obj) => {
    if (!validator.isEmail(obj.Email)) {
      console.warn('Email is invalid', obj.Email)
      return
    }

    if (!obj.LastNotificationTimestamp || CURRENT_DATE_UNIX - obj.LastNotificationTimestamp >= UNIX_DAY) {
      if (!courseCodeEmailMap[obj.CourseCode]) {
        courseCodeEmailMap[obj.CourseCode] = []
      }

      // Assigns the course to to the user's email if they haven't gotten an email today
      courseCodeEmailMap[obj.CourseCode].push(obj.Email)
    } else {
      console.info(`Not sending an email to ${obj.Email} for ${obj.CourseCode} since their last email was sent at ${new Date(obj.LastNotificationTimestamp)}`)
    }
  })

  return courseCodeEmailMap
}

/**
 * Retrieves subscriber data from DynamoDB and creates an object of course codes and emails for all users that should get a notification
 * 
 * @param {Array} courseCodes - Array of course codes to retrieve from DynamoDB
 * @returns {Object} - Returns an array of objects from dynamoDB where each object contains
 * a CourseCode, Email, and LastNotificationTimestamp
 */
async function getDataFromDynamo(courseCodes) {
  console.warn('num courses', courseCodes.length)
  try {
    const dynamoData = await Promise.all(courseCodes.map(async cc => {
      const responseData = await ddb.query({
        TableName: 'Courses',
        KeyConditionExpression: '#course_code = :course_code and begins_with(#email, :email)',
        ExpressionAttributeNames: {
          '#course_code': 'CourseCode',
          '#email': 'Email'
        },
        ExpressionAttributeValues: {
          ':course_code': cc,
          ':email': 'email'
        },
        ProjectionExpression: [ 'CourseCode', 'Email', 'LastNotificationDayTimestamp' ]
      }).promise()

      return responseData.Count > 0 ? responseData.Items : undefined
    }))
    
     // Filters out falsy data
    return dynamoData.flat(1).filter(data => data).map((data) => {
      data.Email = data.Email.substring('email#'.length)
      return data
    })
  } catch (err) {
    console.error('error getting data from dynamodb', err)
  }
}

/**
 * Asynchronously updates the last email timestamp and the list of all notification timestamps in DynamoDB for all the users notified via email
 * 
 * @param {String} courseCode 
 * @param {String} email 
 */
async function updateDynamoData(courseCode, email) {
  const currentTimeUnix = new Date()

  try {
    await ddb.update({
      TableName: 'Courses',
      Key: { 
        'CourseCode': courseCode,
        'Email': `email#${email}`
      },
      UpdateExpression: 'SET #NotificationTimestamps = list_append(#NotificationTimestamps, :sentTimestampList), #LastNotificationDayTimestamp = :sentTimestampDate',
      ExpressionAttributeNames: {
        '#NotificationTimestamps': 'NotificationTimestamps',
        '#LastNotificationDayTimestamp': 'LastNotificationDayTimestamp'
      },
      ExpressionAttributeValues: {
        ':sentTimestampList': [currentTimeUnix.getTime()],
        ':sentTimestampDate': new Date().setHours(0, 0, 0, 0), // using a new date so the logged time is accurate
      }
    }).promise()

    console.info(`Updated timestamp for ${courseCode} and ${email} to ${currentTimeUnix}`)
  } catch (err) {
    console.error(`Error updating the timestamp for ${courseCode} and ${email} in dynamodb`, err)
  }
}