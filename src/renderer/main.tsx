import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/index.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('#root 容器不存在，index.html 可能被错误替换')
}

createRoot(container).render(<App />)
