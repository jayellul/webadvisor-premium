// app.js

const { exec } = require('child_process')
const puppeteer = require('puppeteer')
const wait = require('waait')

// Time between each check in ms
const msBetweenChecks = 0

// Webadvisor course variables
const courseSemester = 'F20'

// max 5 courses
const courses = ['CIS*3260', 'UNIV*2100', 'CIS*1250']

// Headless?
const headless = true

// Start daemon
start()

async function start() {
  while (true) {
    try {
      await checkWebadvisor()
    } catch (error) {
      console.log(error)
    }
  }
}

async function checkWebadvisor() {
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
  // Wait and then check again
  await wait(msBetweenChecks)
}
