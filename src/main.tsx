import { render } from 'preact'
import { App } from './app'
import './style.css'

const theme = new URLSearchParams(location.search).get('theme')
if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme
if (new URLSearchParams(location.search).has('embed')) document.documentElement.classList.add('embed')

render(<App />, document.getElementById('root')!)
