import { useState } from 'react';

const examples = [
  {
    label: 'Budget',
    query: 'Where can I eat under HK$50?',
    intent: ['Budget: under HK$50', 'Search locally stored menu data'],
  },
  {
    label: 'Location',
    query: 'Find a place to eat near the Main Building',
    intent: ['Landmark: Main Building', 'Search locally stored venue data'],
  },
  {
    label: 'Dietary',
    query: '我想找素食',
    intent: ['Language: Chinese', 'Dietary request: vegetarian'],
  },
];

export default function InteractiveDemo() {
  const [selected, setSelected] = useState(0);
  const example = examples[selected];

  return (
    <div className="demo-widget">
      <div className="demo-topline">
        <span className="demo-status"><span /> INTERACTIVE PREVIEW</span>
        <span>Illustration only</span>
      </div>
      <div className="demo-content">
        <p className="demo-label">CHOOSE AN EXAMPLE</p>
        <div className="example-buttons" role="group" aria-label="Example requests">
          {examples.map((item, index) => (
            <button
              key={item.label}
              type="button"
              aria-pressed={selected === index}
              className={selected === index ? 'example-button active' : 'example-button'}
              onClick={() => setSelected(index)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="query-preview">
          <span className="query-icon" aria-hidden="true">✳</span>
          <div>
            <span className="demo-label">YOUR REQUEST</span>
            <p>{example.query}</p>
          </div>
        </div>
        <div className="preview-arrow" aria-hidden="true">↓</div>
        <div className="intent-preview" aria-live="polite">
          <span className="demo-label">WHAT THE APP LOOKS FOR</span>
          <div className="intent-tags">
            {example.intent.map((item) => <span key={item}>{item}</span>)}
          </div>
        </div>
        <p className="demo-note">This preview does not call the model or search the dataset. Run the project locally to see actual results.</p>
      </div>
    </div>
  );
}
