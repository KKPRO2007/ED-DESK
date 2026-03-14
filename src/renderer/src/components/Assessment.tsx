import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Question, TestCase, RubricItem } from '../types'

export default function Assessment() {
  const navigate = useNavigate()
  const [step, setStep] = useState(1)
  const [assessment, setAssessment] = useState({
    title: '',
    description: '',
    timeLimit: 60,
    shuffleQuestions: true,
    shuffleOptions: true,
    showResults: 'after-end' as 'immediately' | 'after-end' | 'never',
    allowRetake: false,
    maxAttempts: 1,
    proctoring: false,
    questions: [] as Question[]
  })

  const [currentQuestion, setCurrentQuestion] = useState<Question>({
    id: Math.random().toString(36).substr(2, 9),
    text: '',
    type: 'mcq',
    options: ['', '', '', ''],
    correctAnswer: '',
    points: 10,
    codeTemplate: '',
    testCases: []
  })

  const addQuestion = () => {
    setAssessment({
      ...assessment,
      questions: [...assessment.questions, currentQuestion]
    })
    setCurrentQuestion({
      id: Math.random().toString(36).substr(2, 9),
      text: '',
      type: 'mcq',
      options: ['', '', '', ''],
      correctAnswer: '',
      points: 10,
      codeTemplate: '',
      testCases: []
    })
  }

  const addTestCase = () => {
    setCurrentQuestion({
      ...currentQuestion,
      testCases: [
        ...(currentQuestion.testCases || []),
        { input: '', expectedOutput: '', weight: 1 }
      ]
    })
  }

  const renderQuestionBuilder = () => {
    switch (currentQuestion.type) {
      case 'mcq':
        return (
          <div className="mcq-builder">
            <h4>Options</h4>
            {currentQuestion.options?.map((opt, idx) => (
              <div key={idx} className="option-input">
                <input
                  type="text"
                  placeholder={`Option ${idx + 1}`}
                  value={opt}
                  onChange={(e) => {
                    const newOptions = [...(currentQuestion.options || [])]
                    newOptions[idx] = e.target.value
                    setCurrentQuestion({ ...currentQuestion, options: newOptions })
                  }}
                />
                <input
                  type="radio"
                  name="correct"
                  checked={currentQuestion.correctAnswer === idx.toString()}
                  onChange={() => setCurrentQuestion({ ...currentQuestion, correctAnswer: idx.toString() })}
                />
              </div>
            ))}
          </div>
        )

      case 'true-false':
        return (
          <div className="truefalse-builder">
            <h4>Correct Answer</h4>
            <div className="truefalse-options">
              <label>
                <input
                  type="radio"
                  name="tf"
                  value="true"
                  checked={currentQuestion.correctAnswer === 'true'}
                  onChange={() => setCurrentQuestion({ ...currentQuestion, correctAnswer: 'true' })}
                />
                True
              </label>
              <label>
                <input
                  type="radio"
                  name="tf"
                  value="false"
                  checked={currentQuestion.correctAnswer === 'false'}
                  onChange={() => setCurrentQuestion({ ...currentQuestion, correctAnswer: 'false' })}
                />
                False
              </label>
            </div>
          </div>
        )

      case 'coding':
        return (
          <div className="coding-builder">
            <h4>Code Template</h4>
            <textarea
              className="code-template"
              value={currentQuestion.codeTemplate}
              onChange={(e) => setCurrentQuestion({ ...currentQuestion, codeTemplate: e.target.value })}
              placeholder="function solution() { ... }"
              rows={6}
            />
            
            <h4>Test Cases</h4>
            {currentQuestion.testCases?.map((tc, idx) => (
              <div key={idx} className="test-case">
                <input
                  type="text"
                  placeholder="Input"
                  value={tc.input}
                  onChange={(e) => {
                    const newTests = [...(currentQuestion.testCases || [])]
                    newTests[idx] = { ...tc, input: e.target.value }
                    setCurrentQuestion({ ...currentQuestion, testCases: newTests })
                  }}
                />
                <input
                  type="text"
                  placeholder="Expected Output"
                  value={tc.expectedOutput}
                  onChange={(e) => {
                    const newTests = [...(currentQuestion.testCases || [])]
                    newTests[idx] = { ...tc, expectedOutput: e.target.value }
                    setCurrentQuestion({ ...currentQuestion, testCases: newTests })
                  }}
                />
                <input
                  type="number"
                  placeholder="Weight"
                  value={tc.weight}
                  onChange={(e) => {
                    const newTests = [...(currentQuestion.testCases || [])]
                    newTests[idx] = { ...tc, weight: parseInt(e.target.value) }
                    setCurrentQuestion({ ...currentQuestion, testCases: newTests })
                  }}
                  min="1"
                  max="10"
                />
                <button onClick={() => {
                  const newTests = currentQuestion.testCases?.filter((_, i) => i !== idx)
                  setCurrentQuestion({ ...currentQuestion, testCases: newTests })
                }}>×</button>
              </div>
            ))}
            <button className="add-testcase" onClick={addTestCase}>
              + Add Test Case
            </button>
          </div>
        )

      default:
        return (
          <div className="shortanswer-builder">
            <h4>Expected Answer</h4>
            <textarea
              value={currentQuestion.correctAnswer as string}
              onChange={(e) => setCurrentQuestion({ ...currentQuestion, correctAnswer: e.target.value })}
              placeholder="Enter expected answer or keywords..."
              rows={3}
            />
          </div>
        )
    }
  }

  return (
    <div className="assessment-creator">
      <div className="creator-header">
        <h2>Create Assessment</h2>
        <div className="progress-steps">
          <div className={`step ${step >= 1 ? 'active' : ''}`}>
            <span className="step-number">1</span>
            <span className="step-label">Basic Info</span>
          </div>
          <div className={`step ${step >= 2 ? 'active' : ''}`}>
            <span className="step-number">2</span>
            <span className="step-label">Questions</span>
          </div>
          <div className={`step ${step >= 3 ? 'active' : ''}`}>
            <span className="step-number">3</span>
            <span className="step-label">Settings</span>
          </div>
          <div className={`step ${step >= 4 ? 'active' : ''}`}>
            <span className="step-number">4</span>
            <span className="step-label">Review</span>
          </div>
        </div>
      </div>

      {step === 1 && (
        <div className="basic-info">
          <div className="form-group">
            <label>Assessment Title</label>
            <input
              type="text"
              value={assessment.title}
              onChange={(e) => setAssessment({ ...assessment, title: e.target.value })}
              placeholder="e.g., Mid-Term Examination 2025"
            />
          </div>

          <div className="form-group">
            <label>Description</label>
            <textarea
              value={assessment.description}
              onChange={(e) => setAssessment({ ...assessment, description: e.target.value })}
              placeholder="Describe the assessment, topics covered, etc."
              rows={4}
            />
          </div>

          <div className="form-group">
            <label>Time Limit (minutes)</label>
            <input
              type="number"
              value={assessment.timeLimit}
              onChange={(e) => setAssessment({ ...assessment, timeLimit: parseInt(e.target.value) })}
              min="5"
              max="300"
            />
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="questions-builder">
          <div className="question-list">
            {assessment.questions.map((q, idx) => (
              <div key={q.id} className="question-preview">
                <span className="question-number">Q{idx + 1}</span>
                <span className="question-text">{q.text.substring(0, 50)}...</span>
                <span className="question-type">{q.type}</span>
                <span className="question-points">{q.points} pts</span>
              </div>
            ))}
          </div>

          <div className="question-editor">
            <h3>Add Question</h3>
            
            <div className="form-group">
              <label>Question Type</label>
              <select
                value={currentQuestion.type}
                onChange={(e) => setCurrentQuestion({
                  ...currentQuestion,
                  type: e.target.value as any,
                  options: e.target.value === 'mcq' ? ['', '', '', ''] : undefined
                })}
              >
                <option value="mcq">Multiple Choice</option>
                <option value="true-false">True/False</option>
                <option value="short-answer">Short Answer</option>
                <option value="coding">Coding</option>
                <option value="file-upload">File Upload</option>
              </select>
            </div>

            <div className="form-group">
              <label>Question Text</label>
              <textarea
                value={currentQuestion.text}
                onChange={(e) => setCurrentQuestion({ ...currentQuestion, text: e.target.value })}
                placeholder="Enter your question..."
                rows={3}
              />
            </div>

            {renderQuestionBuilder()}

            <div className="form-group">
              <label>Points</label>
              <input
                type="number"
                value={currentQuestion.points}
                onChange={(e) => setCurrentQuestion({ ...currentQuestion, points: parseInt(e.target.value) })}
                min="1"
                max="100"
              />
            </div>

            <div className="editor-actions">
              <button className="btn btn-primary" onClick={addQuestion}>
                Add Question
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="assessment-settings">
          <h3>Advanced Settings</h3>
          
          <div className="settings-grid">
            <div className="setting-item">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={assessment.shuffleQuestions}
                  onChange={(e) => setAssessment({ ...assessment, shuffleQuestions: e.target.checked })}
                />
                <span className="slider"></span>
              </label>
              <div className="setting-info">
                <h4>Shuffle Questions</h4>
                <p>Randomize question order for each student</p>
              </div>
            </div>

            <div className="setting-item">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={assessment.shuffleOptions}
                  onChange={(e) => setAssessment({ ...assessment, shuffleOptions: e.target.checked })}
                />
                <span className="slider"></span>
              </label>
              <div className="setting-info">
                <h4>Shuffle Options</h4>
                <p>Randomize answer choices for MCQs</p>
              </div>
            </div>

            <div className="setting-item">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={assessment.allowRetake}
                  onChange={(e) => setAssessment({ ...assessment, allowRetake: e.target.checked })}
                />
                <span className="slider"></span>
              </label>
              <div className="setting-info">
                <h4>Allow Retakes</h4>
                <p>Students can attempt multiple times</p>
              </div>
            </div>

            {assessment.allowRetake && (
              <div className="setting-item">
                <label>Max Attempts</label>
                <input
                  type="number"
                  value={assessment.maxAttempts}
                  onChange={(e) => setAssessment({ ...assessment, maxAttempts: parseInt(e.target.value) })}
                  min="1"
                  max="10"
                />
              </div>
            )}

            <div className="setting-item">
              <label>Show Results</label>
              <select
                value={assessment.showResults}
                onChange={(e) => setAssessment({ ...assessment, showResults: e.target.value as any })}
              >
                <option value="immediately">Immediately after submission</option>
                <option value="after-end">After assessment ends</option>
                <option value="never">Never (manual release)</option>
              </select>
            </div>

            <div className="setting-item">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={assessment.proctoring}
                  onChange={(e) => setAssessment({ ...assessment, proctoring: e.target.checked })}
                />
                <span className="slider"></span>
              </label>
              <div className="setting-info">
                <h4>Enable Proctoring</h4>
                <p>Monitor student activity during assessment</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="review-assessment">
          <h3>Review Assessment</h3>
          
          <div className="review-summary">
            <div className="summary-item">
              <span>Title:</span>
              <strong>{assessment.title}</strong>
            </div>
            <div className="summary-item">
              <span>Questions:</span>
              <strong>{assessment.questions.length}</strong>
            </div>
            <div className="summary-item">
              <span>Total Points:</span>
              <strong>
                {assessment.questions.reduce((sum, q) => sum + q.points, 0)}
              </strong>
            </div>
            <div className="summary-item">
              <span>Time Limit:</span>
              <strong>{assessment.timeLimit} minutes</strong>
            </div>
          </div>

          <div className="review-questions">
            <h4>Questions Preview</h4>
            {assessment.questions.map((q, idx) => (
              <div key={q.id} className="review-question">
                <h5>Question {idx + 1} ({q.points} points)</h5>
                <p>{q.text}</p>
                {q.type === 'mcq' && (
                  <ul>
                    {q.options?.map((opt, i) => (
                      <li key={i} className={i.toString() === q.correctAnswer ? 'correct' : ''}>
                        {opt} {i.toString() === q.correctAnswer && '✓'}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="creator-footer">
        <button
          className="btn btn-secondary"
          onClick={() => setStep(step - 1)}
          disabled={step === 1}
        >
          Previous
        </button>
        {step < 4 ? (
          <button
            className="btn btn-primary"
            onClick={() => setStep(step + 1)}
          >
            Next
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={() => {
              // Create assessment session
              navigate('/assessment/success')
            }}
          >
            Create Assessment
          </button>
        )}
      </div>
    </div>
  )
}