// app.js

const { exec } = require('child_process')
const puppeteer = require('puppeteer')
const wait = require('waait')
const nodemailer = require("nodemailer");
const fs = require('fs')
const express = require('express')
const bodyParser = require('body-parser');
const _ = require('lodash')
const { check, validationResult, matchedData } = require('express-validator');

// Reads a .env file
require('dotenv').config();

const app = express()

// Time between each check in ms
const msBetweenChecks = 0

// Webadvisor course variables
const courseSemester = 'F20'

// Headless?
const headless = true

const PORT = 3000

app.use(bodyParser.urlencoded({ extended: false }))

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
  const formErrors = validationResult(req);

  if (!formErrors.isEmpty()) {
    console.error('formErrors', formErrors)
    return res.status(400).send(`formErrors -- ${JSON.stringify(formErrors)}`)
  }
  
  // Ensures the app only uses data that has been validated
  const validatedData = matchedData(req)

  // start an instance of the service
  start(validatedData.courses, validatedData.email)
  return res.send('started a new process')
})

app.listen(PORT);


async function start(courses, recipients) {
  while (true) {
    try {
      const availableCourseInfo = await checkWebadvisor(courses)

      sendEmail(availableCourseInfo, recipients)

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
  await page.waitForNavigation({ waitUntil: 'networkidle0' })

  await Promise.all([
    page.click('#sidebar > div > div.subnav > ul > li:nth-child(2) > a'),
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
  ])

  await Promise.all([
    page.click('#sidebar > div > ul:nth-child(2) > li > a'),
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
  ])

  // Fill out Search for Sections
  await Promise.all([
    page.select('#VAR1', courseSemester),
    ...courses
      .map((course, i) => {
        const row = i + 1
        const [courseSubject, courseCode] = course.split('*')
        return [
          page.select(`#LIST_VAR1_${row}`, courseSubject),
          page.evaluate(
            (courseCode, row) => {
              const courseCodeInput = document.querySelector(`#LIST_VAR3_${row}`)
              courseCodeInput.value = courseCode
            },
            courseCode,
            row
          ),
        ]
      })
      .flat(),
  ])

  await Promise.all([
    page.click('#content > div.screen.WESTS12A > form > div > input'),
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
  ])

  // Determine if offering is open - evaluated in browser
  const availableCourseInfo = await page.evaluate((courses) => {
    const offerings = document.querySelectorAll('#GROUP_Grp_WSS_COURSE_SECTIONS > table > tbody > tr')

    // generate base course map Ex. { 'CIS*1234': [] } cant use ES6 :(
    const courseMap = {}
    courses.forEach((course) => (courseMap[course] = []))

    offerings.forEach((row, index) => {
      // First two rows are just headings
      if (index < 2) return

      Object.keys(courseMap).forEach((courseKey) => {
        // Look for a course row that doesn't have the closed styles
        if (!row.className && row.className !== 'closed') {
          if (row.innerText.includes(courseKey)) {
            // parse columns into array for easy access
            const splitCourseRow = row.innerText
              .split('\n\n')
              .map((s) => s.trim())
              .filter((s) => s.length)

            // add available course info to course map
            courseMap[courseKey].push(splitCourseRow)
          }
        }
      })
    })

    return courseMap
  }, courses)

  // log time
  console.log(`\nTIME: ${new Date().toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true })}`)

  // check and log open/full sections
  Object.keys(availableCourseInfo).forEach((courseKey) => {
    const openSections = availableCourseInfo[courseKey]
    if (openSections.length) {
      exec(`say "${courseKey} has available sections"`)
      // todo: can display the open sections in a nicer format
      console.log('\x1b[32m', `\n${courseKey} HAS AVAILABLE SECTIONS`, JSON.stringify(openSections))
    } else {
      console.log('\x1b[31m', `\n${courseKey} DOES NOT HAVE AVAILABLE SECTIONS`)
    }
  })

  console.log('\x1b[37m', '\nAYO, THREAD CHECK\n')
  await browser.close()

  return availableCourseInfo
}

async function sendEmail(courseMap, recipients) {  
  const EMAIL_SERVICE = process.env.EMAIL_SERVICE
  const EMAIL_ADDR = process.env.EMAIL_ADDR
  const EMAIL_PWD = process.env.EMAIL_PWD

  if (!EMAIL_SERVICE || !EMAIL_ADDR || !EMAIL_PWD || !recipients) {
    console.warn('Email sending is not enabled. To enable email sending please set the EMAIL_SERVICE, EMAIL_ADDR and EMAIL_PWD env variables')
    return
  }

  const transporter = nodemailer.createTransport({
    service: EMAIL_SERVICE,
    auth: {
      user: EMAIL_ADDR,
      pass: EMAIL_PWD
    }
  });  
  
  let courseDetailsHTML = ''

  Object.entries(courseMap).forEach(([courseCode, details]) => {
    courseDetailsHTML += formatCourseInfoHTML(courseCode, details)
  })

  if (!courseDetailsHTML) {
    console.warn('No courses were available so no email was sent')
    return
  }

  const info = await transporter.sendMail({
    from: EMAIL_ADDR, 
    to: recipients, 
    subject: 'Your course selection info', 
    html: fs.readFileSync(__dirname + '/templates/coursesAvailableEmail.html', 'utf8').replace('${INSERT_INFO_HERE}', courseDetailsHTML),
  });

  console.info('emails sent to', info.accepted)
  console.info('emails did not send to', info.rejected)
}

function formatCourseInfoHTML(courseCode, courseInfo) {
  if (courseInfo.length) {
    return `<p><b>${courseCode}</b> has sections available</p> <p>${courseInfo}</p> <br>`
  }

  return ''
}